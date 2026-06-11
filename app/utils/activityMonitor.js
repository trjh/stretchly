import EventEmitter from 'events'
import log from 'electron-log/main.js'
// Static ESM import (matches naturalBreaksManager.js). Outside Electron (e.g. the
// vitest suite) this resolves to `undefined`, which isPermitted() guards for.
import { systemPreferences } from 'electron'

// ActivityMonitor — RSIGuard-style activity-based break triggering.
//
// Modeled on naturalBreaksManager.js. Counts real keyboard + mouse activity via
// the optional `uiohook-napi` global input hook, accumulates a weighted "strain"
// score (keys + clicks + throttled mouse-move distance), decays the score while
// the user is idle, and emits `activityThresholdReached` when the score crosses a
// configurable threshold. It is intended to run ALONGSIDE the wall-clock timer
// (max-of-both): whichever fires first triggers the break.
//
// macOS caveat (validated in pass 2): uiohook-napi's native start() ABORTS the
// process (SIGABRT, "Accessibility API is disabled!") if the host process has not
// been granted Input Monitoring / Accessibility permission. That abort happens on
// a native thread and CANNOT be caught with try/catch. We therefore gate start()
// behind an Electron systemPreferences trust check, and only call uIOhook.start()
// when the platform reports the process is trusted. If it is not trusted (or the
// module is unavailable) we degrade gracefully: the monitor stays inert and the
// existing wall-clock timer is unaffected.

class ActivityMonitor extends EventEmitter {
  constructor (settings) {
    super()
    this.settings = settings
    this.usingActivityTrigger = false
    this.uIOhook = null
    this.hookStarted = false
    // True while an async _startHook() is in flight (module import + native
    // start). Together with hookStarted this makes start() idempotent.
    this._starting = false
    // Monotonic start-attempt token. Bumped by every start() and stop(); a
    // _startHook() continuation that resumes after the async module import
    // checks it to detect that a stop()+start() race superseded it, so the
    // native hook/tick interval can never be double-started.
    this._startToken = 0
    this.timer = null

    // strain accumulator state
    this.strain = 0
    this._lastMouse = null
    this._lastMouseMoveAccrued = 0
    this._lastTickTs = Date.now()
    // NOTE: we intentionally do NOT auto-start here. The owner (BreaksPlanner via
    // main.js) calls start() explicitly AFTER subscribing to our events, so the
    // permissionRequired event isn't emitted before anyone is listening.
  }

  // --- weights / tunables, read live from settings with sane fallbacks ---
  get _keyWeight () { return this.settings.get('activityKeyWeight') ?? 1 }
  get _clickWeight () { return this.settings.get('activityClickWeight') ?? 2 }
  // strain per 1000px of (throttled) mouse travel
  get _moveWeightPer1000px () { return this.settings.get('activityMoveWeight') ?? 1 }
  get _threshold () { return this.settings.get('activityThreshold') ?? 6000 }
  // idle ms before strain starts decaying
  get _idleMs () { return this.settings.get('activityIdleResetTime') ?? 30000 }
  // fraction of strain shed per second while idle
  get _decayPerSecond () { return this.settings.get('activityDecayPerSecond') ?? 0.1 }

  // Returns true only when the OS reports the host process may observe global
  // input. On macOS this is the Accessibility/Input-Monitoring trust check; on
  // other platforms libuiohook does not abort, so we allow start.
  isPermitted () {
    if (process.platform !== 'darwin') return true
    try {
      // isTrustedAccessibilityClient(false) => query without prompting. macOS
      // surfaces global key/mouse taps (what libuiohook needs) under the same
      // trust check exposed here.
      if (systemPreferences && typeof systemPreferences.isTrustedAccessibilityClient === 'function') {
        return systemPreferences.isTrustedAccessibilityClient(false)
      }
    } catch (e) {
      log.warn(`Stretchly: ActivityMonitor could not query accessibility trust: ${e.message}`)
    }
    return false
  }

  start () {
    // Idempotent. initialize(false) (restore-defaults / remote-settings
    // restore) calls activityTrigger(true) even when we're already running; a
    // second start() must NOT rebind listeners, re-call uIOhook.start(), or
    // spawn a duplicate tick interval — any of which would corrupt state or
    // disable the feature. If the hook is already active (or a start is in
    // flight), do nothing and leave the running monitor untouched.
    if (this.hookStarted || this._starting) return

    this.usingActivityTrigger = true
    this.strain = 0
    this._lastMouse = null
    this._lastMouseMoveAccrued = 0
    this._lastTickTs = Date.now()

    if (!this.isPermitted()) {
      log.warn('Stretchly: ActivityMonitor NOT started — Input Monitoring/Accessibility permission not granted to Stretchly. Activity trigger is inert; wall-clock timer still applies.')
      this.emit('permissionRequired')
      return
    }

    // Load + start the native hook asynchronously. uiohook-napi is an optional
    // dependency loaded via dynamic import() (this is ESM), so a missing module
    // degrades gracefully instead of throwing at module-eval time.
    this._starting = true
    this._startHook(++this._startToken)
  }

  // Loads the optional native hook module. Extracted so tests can control the
  // in-flight timing of the async import deterministically.
  async _loadHook () {
    const mod = await import('uiohook-napi')
    return mod.uIOhook ?? mod.default?.uIOhook
  }

  async _startHook (token) {
    if (!this.uIOhook) {
      try {
        this.uIOhook = await this._loadHook()
      } catch (e) {
        log.warn(`Stretchly: ActivityMonitor could not load uiohook-napi: ${e.message}`)
        // Only the current attempt may mutate shared state; a stale
        // continuation must not clobber a newer start()'s flags.
        if (token === this._startToken) {
          this.usingActivityTrigger = false
          this._starting = false
        }
        return
      }
    }

    // Stale-continuation guard. A stop() (or a newer start()) since this call was
    // launched bumped _startToken; if ours no longer matches, the feature was
    // toggled off, or the hook is already running, we must NOT bind/start again
    // — otherwise a stop()+start() race during the async import() above could
    // double-start the native hook or spawn a duplicate tick interval. Leave
    // _starting for the current owner to manage when we're stale.
    if (token !== this._startToken || !this.usingActivityTrigger || this.hookStarted) {
      if (token === this._startToken) this._starting = false
      return
    }

    this._bindHook()
    try {
      this.uIOhook.start()
      this.hookStarted = true
      log.info('Stretchly: ActivityMonitor started (global input hook active)')
    } catch (e) {
      // Note: a real permission failure aborts the process before this; this
      // catch only covers ordinary JS throws (e.g. double-start).
      log.warn(`Stretchly: ActivityMonitor uIOhook.start() failed: ${e.message}`)
      this.usingActivityTrigger = false
      this._starting = false
      return
    }

    this.timer = setInterval(() => this._tick(), 1000)
    this._starting = false
  }

  stop () {
    this.usingActivityTrigger = false
    this._starting = false
    // Invalidate any in-flight _startHook() continuation (see _startHook).
    this._startToken++
    clearInterval(this.timer)
    this.timer = null
    this.strain = 0
    if (this.uIOhook && this.hookStarted) {
      try {
        this.uIOhook.removeAllListeners()
        this.uIOhook.stop()
      } catch (e) {
        log.warn(`Stretchly: ActivityMonitor stop error: ${e.message}`)
      }
      this.hookStarted = false
    }
    log.info('Stretchly: ActivityMonitor stopped')
  }

  _bindHook () {
    if (!this.uIOhook) return
    this.uIOhook.removeAllListeners()
    this.uIOhook.on('keydown', () => { this._onActivity(this._keyWeight) })
    this.uIOhook.on('click', () => { this._onActivity(this._clickWeight) })
    this.uIOhook.on('wheel', () => { this._onActivity(this._clickWeight) })
    this.uIOhook.on('mousemove', (e) => { this._onMouseMove(e) })
  }

  _onActivity (weight) {
    this.strain += weight
    this._lastActivityTs = Date.now()
  }

  // Mouse-move distance is throttled: we accumulate pixel travel and convert to
  // strain in the 1s tick, so a frantic mouse can't spam thousands of events
  // into a runaway score.
  _onMouseMove (e) {
    this._lastActivityTs = Date.now()
    if (this._lastMouse) {
      const dx = e.x - this._lastMouse.x
      const dy = e.y - this._lastMouse.y
      this._lastMouseMoveAccrued += Math.sqrt(dx * dx + dy * dy)
    }
    this._lastMouse = { x: e.x, y: e.y }
  }

  _tick () {
    const now = Date.now()
    const dtSeconds = Math.max(0.001, (now - this._lastTickTs) / 1000)
    this._lastTickTs = now

    // fold accrued mouse travel into strain
    if (this._lastMouseMoveAccrued > 0) {
      this.strain += (this._lastMouseMoveAccrued / 1000) * this._moveWeightPer1000px
      this._lastMouseMoveAccrued = 0
    }

    // decay while idle
    const idleFor = this._lastActivityTs ? now - this._lastActivityTs : Infinity
    if (idleFor > this._idleMs && this.strain > 0) {
      const factor = Math.max(0, 1 - this._decayPerSecond * dtSeconds)
      this.strain *= factor
      if (this.strain < 1) this.strain = 0
    }

    if (this.strain >= this._threshold) {
      log.info(`Stretchly: ActivityMonitor strain ${Math.round(this.strain)} >= threshold ${this._threshold}, requesting break`)
      this.strain = 0
      this.emit('activityThresholdReached')
    }
  }

  get currentStrain () {
    return Math.round(this.strain)
  }
}

export default ActivityMonitor
