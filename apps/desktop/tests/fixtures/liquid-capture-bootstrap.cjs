const { app, BrowserWindow, nativeTheme } = require('electron')
const assert = require('node:assert/strict')
const { writeFileSync } = require('node:fs')
const { join } = require('node:path')
const root = process.env.LIQUID_TEST_EVIDENCE
app.commandLine.appendSwitch('enable-blink-features', 'CanvasDrawElement')
app.setPath('userData', join(root, 'profile'))
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const deadline = setTimeout(() => { console.error('Native liquid capture timed out'); app.exit(1) }, 45000)
app.whenReady().then(async () => {
  nativeTheme.themeSource = 'light'
  const win = new BrowserWindow({ width: 800, height: 600, show: true, webPreferences: { backgroundThrottling: false } })
  const wc = win.webContents
  const result = { cases: [], frames: 0, black: [], errors: [] }
  let sampling = false
  const run = code => wc.executeJavaScript(code)
  const state = () => run('({...liquidFixture.state})')
  const waitFor = async predicate => {
    const until = Date.now() + 10000
    while (!await run(predicate)) { assert.ok(Date.now() < until, predicate); await sleep(30) }
  }
  const pixel = async () => {
    const image = await wc.capturePage()
    const { width, height } = image.getSize(), bytes = image.toBitmap()
    const offset = ((height - 30) * width + width - 30) * 4
    return [...bytes.subarray(offset, offset + 3)]
  }
  wc.on('console-message', event => {
    if (event.level === 'error') result.errors.push(event.message)
  })
  try {
    await win.loadURL(process.env.LIQUID_TEST_URL)
    await waitFor('window.liquidFixture?.state.copies > 0 && liquidFixture.state.presents > 0')
    await sleep(100)
    assert.ok((await pixel()).every(value => value > 180), 'initial content must be captured')
    wc.beginFrameSubscription(false, image => {
      if (!sampling) return
      const { width, height } = image.getSize(), bytes = image.toBitmap()
      const offset = ((height - 30) * width + width - 30) * 4
      result.frames += 1
      if ([...bytes.subarray(offset, offset + 3)].every(value => value < 30)) {
        result.black.push(result.frames)
        if (result.black.length < 4) writeFileSync(join(root, `black-${result.frames}.png`), image.toPNG())
      }
    })
    sampling = true
    const before = await state()
    await run('liquidFixture.animate()')
    const after = await state()
    assert.ok(after.presents - before.presents >= 12, 'WAAPI paints must present throughout the 360ms animation without React invalidation')
    result.cases.push(`native animation: ${after.presents - before.presents} presentations`)
    await run("liquidFixture.state.blocked = true; liquidFixture.replace('#d4ecd9')")
    const heldPixel = await pixel(), failuresBefore = (await state()).failures
    for (let index = 0; index < 15; index++) {
      await run('liquidFixture.render(); liquidFixture.repaint()')
      await sleep(17)
    }
    assert.ok((await state()).failures > failuresBefore, 'must actually exercise capture failures')
    assert.deepEqual(await pixel(), heldPixel, 'failed copies must retain the completed frame beyond ten attempts')
    result.cases.push('15 failed capture retries retain the complete frame')
    win.setSize(980, 720)
    await sleep(120)
    assert.ok((await pixel()).every(value => value > 180), 'failed capture after growing the canvas must not expose black borders')
    result.cases.push('canvas growth preserves a fully covered frame')
    const presentsBeforeRecovery = (await state()).presents
    await run('liquidFixture.state.blocked = false; liquidFixture.repaint()')
    await waitFor(`liquidFixture.state.presents > ${presentsBeforeRecovery}`)
    await sleep(70)
    const recovered = await pixel()
    assert.ok(recovered[1] > recovered[0] && recovered[1] > recovered[2], 'paint alone must present the new green content')
    result.cases.push('paint resumes demand rendering after capture recovery')
    sampling = false
    const idleBefore = (await state()).presents
    await sleep(150)
    assert.equal((await state()).presents, idleBefore, 'presenting must not cause a self-sustaining paint loop')
    await run('liquidFixture.destroy(); liquidFixture.repaint()')
    await sleep(70)
    assert.equal((await state()).presents, idleBefore, 'destroyed renderer must not submit more frames')
    assert.equal(result.black.length, 0, 'no incomplete black frame may be presented')
    assert.equal(result.errors.length, 0, 'native renderer must not emit errors')
    result.status = 'passed'
    console.log(JSON.stringify(result))
  } catch (error) {
    result.status = 'failed'; result.error = String(error)
    console.error(error)
    process.exitCode = 1
  } finally {
    wc.endFrameSubscription()
    writeFileSync(join(root, 'result.json'), JSON.stringify(result, null, 2))
    win.destroy()
    clearTimeout(deadline)
    app.exit(process.exitCode || 0)
  }
})
