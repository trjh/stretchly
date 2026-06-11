import 'chai/register-should'
import { join } from 'path'
import ActivityMonitor from '../app/utils/activityMonitor'
import Store from 'electron-store'
import defaultSettings from '../app/utils/defaultSettings'
import { unlink } from 'node:fs'

describe('activityMonitor', function () {
  let settings = null
  let activityMonitor = null

  beforeEach(() => {
    settings = new Store({
      cwd: join(__dirname),
      name: 'test-settings-activityMonitor',
      defaults: defaultSettings
    })
    activityMonitor = new ActivityMonitor(settings)
  })

  it('is inert by default (does not auto-start in constructor)', () => {
    activityMonitor.usingActivityTrigger.should.be.equal(false)
    activityMonitor.hookStarted.should.be.equal(false)
    activityMonitor.currentStrain.should.be.equal(0)
  })

  it('does not start the hook and emits permissionRequired when not permitted', () => {
    // Simulate macOS-without-permission (or any host where start() must be gated).
    activityMonitor.isPermitted = () => false
    let permissionRequired = false
    activityMonitor.on('permissionRequired', () => { permissionRequired = true })

    activityMonitor.start()

    permissionRequired.should.be.equal(true)
    // The native hook must NEVER be started in this state (would SIGABRT on macOS).
    activityMonitor.hookStarted.should.be.equal(false)
    ;(activityMonitor.timer === null).should.be.equal(true)
    // usingActivityTrigger reflects the user's intent (enabled) even while dormant.
    activityMonitor.usingActivityTrigger.should.be.equal(true)
  })

  it('stop() is safe even when never started, and resets state', () => {
    activityMonitor.isPermitted = () => false
    activityMonitor.start()
    activityMonitor.stop()
    activityMonitor.usingActivityTrigger.should.be.equal(false)
    activityMonitor.hookStarted.should.be.equal(false)
    activityMonitor.currentStrain.should.be.equal(0)
  })

  it('start() is idempotent — repeated starts do not duplicate the hook or interval', () => {
    // initialize(false) (restore-defaults / remote-settings restore) can call
    // activityTrigger(true) while the monitor is already running. A second
    // start() must not re-call uIOhook.start() (potential double-start throw) or
    // spawn a duplicate tick interval, and must leave the feature enabled.
    let startCalls = 0
    let intervalCalls = 0
    const stub = {
      start: () => { startCalls++ },
      stop: () => {},
      on: () => {},
      removeAllListeners: () => {}
    }
    activityMonitor.isPermitted = () => true
    // Preset the hook so _startHook() skips its async import() and runs to
    // completion synchronously within start().
    activityMonitor.uIOhook = stub

    const realSetInterval = global.setInterval
    global.setInterval = (...args) => { intervalCalls++; return realSetInterval(...args) }
    try {
      activityMonitor.start()
      activityMonitor.start()
      activityMonitor.start()
    } finally {
      global.setInterval = realSetInterval
    }

    startCalls.should.be.equal(1)
    intervalCalls.should.be.equal(1)
    activityMonitor.hookStarted.should.be.equal(true)
    activityMonitor.usingActivityTrigger.should.be.equal(true)
  })

  it('does not double-start across a stop/start race while the hook import is in flight', async () => {
    // Reproduces the stop()+start() race: start() begins loading the optional
    // native module, stop() then start() fire before the import resolves. Both
    // _startHook() continuations resume against a now-enabled monitor; only the
    // latest (current-token) one may bind/start. We must end with exactly one
    // native start() and one tick interval.
    let startCalls = 0
    let intervalCalls = 0
    const stub = {
      start: () => { startCalls++ },
      stop: () => {},
      on: () => {},
      removeAllListeners: () => {}
    }
    activityMonitor.isPermitted = () => true

    // Control exactly when the (simulated) module import resolves, and leave
    // uIOhook unset so both starts go through the async load path.
    let resolveLoad
    const loadPromise = new Promise((resolve) => { resolveLoad = resolve })
    activityMonitor._loadHook = () => loadPromise

    const realSetInterval = global.setInterval
    global.setInterval = (...args) => { intervalCalls++; return realSetInterval(...args) }
    try {
      activityMonitor.start() // attempt #1 — awaits the pending import
      activityMonitor.stop() // cancels #1 (bumps the start token)
      activityMonitor.start() // attempt #2 — also awaits the pending import
      resolveLoad(stub) // both continuations now resume
      await loadPromise
      // flush the chained _startHook() continuations
      await Promise.resolve()
      await Promise.resolve()
    } finally {
      global.setInterval = realSetInterval
    }

    startCalls.should.be.equal(1)
    intervalCalls.should.be.equal(1)
    activityMonitor.hookStarted.should.be.equal(true)
    activityMonitor.usingActivityTrigger.should.be.equal(true)
  })

  it('accumulates weighted strain from keys and clicks', () => {
    settings.set('activityKeyWeight', 1)
    settings.set('activityClickWeight', 2)
    // 50 keys * 1 + 20 clicks * 2 = 90
    for (let i = 0; i < 50; i++) activityMonitor._onActivity(activityMonitor._keyWeight)
    for (let i = 0; i < 20; i++) activityMonitor._onActivity(activityMonitor._clickWeight)
    activityMonitor.currentStrain.should.be.equal(90)
  })

  it('folds throttled mouse-move distance into strain on tick', () => {
    settings.set('activityMoveWeight', 1)
    // Two moves accruing 12000px of travel -> +12 strain at 1 per 1000px.
    activityMonitor._onMouseMove({ x: 0, y: 0 })
    activityMonitor._onMouseMove({ x: 12000, y: 0 })
    activityMonitor._tick()
    activityMonitor.currentStrain.should.be.equal(12)
  })

  it('emits activityThresholdReached and resets strain on crossing', () => {
    settings.set('activityThreshold', 100)
    settings.set('activityKeyWeight', 1)
    let fired = 0
    activityMonitor.on('activityThresholdReached', () => { fired++ })
    for (let i = 0; i < 100; i++) activityMonitor._onActivity(activityMonitor._keyWeight)
    activityMonitor.currentStrain.should.be.equal(100)
    activityMonitor._tick()
    fired.should.be.equal(1)
    activityMonitor.currentStrain.should.be.equal(0)
  })

  it('decays strain while idle past the idle reset time', () => {
    settings.set('activityIdleResetTime', 0)
    settings.set('activityDecayPerSecond', 0.5)
    settings.set('activityThreshold', 100000)
    // Seed strain and backdate last activity/tick so the idle branch runs.
    activityMonitor.strain = 50
    activityMonitor._lastActivityTs = Date.now() - 10000
    activityMonitor._lastTickTs = Date.now() - 1000
    activityMonitor._tick()
    // 50 * (1 - 0.5 * ~1s) = ~25
    activityMonitor.currentStrain.should.be.at.least(24)
    activityMonitor.currentStrain.should.be.at.most(26)
  })

  afterEach(() => {
    activityMonitor.stop()
    activityMonitor = null

    if (settings) {
      unlink(join(__dirname, '/test-settings-activityMonitor.json'), (_) => {})
      settings = null
    }
  })
})
