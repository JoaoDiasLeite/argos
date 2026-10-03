// Visual-check driver for the Ops workspace: seeds a server, opens a runbook through the
// real start screen against the fake ops backend (ARGOS_OPS_FAKE=1), and saves screenshots.
//
//   VISUAL_CHECK_DRIVER=scripts/visual-check/ops-demo.js
//   VISUAL_CHECK_RUNBOOK=<runbook folder>   VISUAL_CHECK_OUTDIR=<where the PNGs go>
//   ARGOS_OPS_FAKE=1  [ARGOS_OPS_FAKE_OUT=<text file the fake prints for every command>]
//
// Clicks are DOM clicks inside this process, never OS input, so nothing can land on
// another window. Set VISUAL_CHECK_DUMP=1 to also write a text dump of the buttons per step.
const fs = require('fs')
const path = require('path')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

module.exports = async function ({ app, BrowserWindow }) {
  const out = process.env.VISUAL_CHECK_OUTDIR || path.join(__dirname, 'ops-demo-out')
  const runbook = process.env.VISUAL_CHECK_RUNBOOK
  fs.mkdirSync(out, { recursive: true })

  // The app also opens helper windows (quick-ask overlay, pill, toast). The main one is the
  // only one whose page is not a helper route and that is not always-on-top.
  const isMain = (x) => {
    if (x.isDestroyed() || x.isAlwaysOnTop()) return false
    const url = x.webContents.getURL()
    return url !== '' && !/overlay|pill|toast|popup/i.test(url)
  }
  const mainWin = async () => {
    for (let i = 0; i < 60; i++) {
      const w = BrowserWindow.getAllWindows().find((x) => isMain(x) && x.getBounds().width > 400)
      if (w && !w.webContents.isLoading()) return w
      await sleep(500)
    }
    throw new Error('main window never appeared: ' + BrowserWindow.getAllWindows().map((x) => x.webContents.getURL()).join(' , '))
  }
  const win = await mainWin()
  console.log('main window url:', win.webContents.getURL())
  const js = (code) => win.webContents.executeJavaScript(code)
  win.setBounds({ x: 0, y: 0, width: 1500, height: 950 })

  const shot = async (name) => {
    await sleep(700)
    const img = await win.webContents.capturePage()
    fs.writeFileSync(path.join(out, `${name}.png`), img.toPNG())
    console.log('shot', name)
  }
  const dump = async (name) => {
    if (process.env.VISUAL_CHECK_DUMP !== '1') return
    const t = await js(`[...document.querySelectorAll('button,[role=button],select,input,textarea')].map(e => (e.tagName + ' | ' + (e.getAttribute('aria-label')||'') + ' | ' + (e.innerText||e.value||e.placeholder||'').trim().slice(0,60) + ' | ' + e.className.toString().slice(0,50))).join('\\n')`)
    fs.writeFileSync(path.join(out, `${name}.txt`), t)
  }
  // Click the first visible element whose own text equals `text` (or whose selector matches).
  const click = async (text, sel = 'button,[role=button],[role=option],a') => {
    const ok = await js(`(() => {
      const els = [...document.querySelectorAll(${JSON.stringify(sel)})]
      const el = els.find(e => e.offsetParent !== null && (e.innerText||'').trim().replace(/\\s+/g,' ').startsWith(${JSON.stringify(text)}))
      if (!el) return false
      el.click(); return true
    })()`)
    if (!ok) throw new Error(`nothing to click: ${text}`)
    await sleep(600)
  }

  // 1. A stored server and the runbook in the recents, then reload so the app reads them.
  await js(`window.electronAPI.sshSave({ id: 'ssh_demo', name: 'proxmox-pve', host: '10.0.0.5', port: 22, username: 'ops', authType: 'password', password: 'demo' })`)
  if (runbook) await js(`localStorage.setItem('ops.recentRunbooks', ${JSON.stringify(JSON.stringify([runbook]))})`)
  win.webContents.reload()
  await sleep(5000)
  await dump('01-home')
  await shot('01-home')

  // 2. Servers (the "remote" view) and its Ops entry.
  win.webContents.send('app:open-view', 'remote')
  await sleep(2500)
  await dump('02-servers')
  await shot('02-servers')

  // 3. The Ops tab: the start screen of an intervention.
  await click('Ops')
  await sleep(1500)
  await dump('03-ops-start')
  await shot('03-ops-start')

  // 4. Server, then runbook, through the dropdowns the operator would use.
  const dd = async (index, optionText) => {
    await js(`document.querySelectorAll('.ivs-dd > button')[${index}].click()`)
    await sleep(500)
    await dump(`dd${index}-open`)
    await click(optionText, '.ivs-dd-list [role=option], .ivs-dd-list button, .ivs-dd-list *[role=option]')
  }
  await dd(0, 'proxmox-pve')
  await dd(1, 'proxmox-access')
  await sleep(1500)
  await dump('04-ready')
  await shot('04-ready')

  // 5. Start. The session opens against the fake backend; the CLI is launched for real,
  //    which only matters for the terminal pane, not for the activity column.
  await click('Start')
  await sleep(9000)
  await dump('05-running')
  await shot('05-running')
  if (process.env.VISUAL_CHECK_STOP_AT === '05') return app.exit(0)

  // 6. The Scripts list: open it, click the script (confirm row), run it, read the result.
  const clickSel = async (sel, wait = 600) => {
    const ok = await js(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return false; e.click(); return true })()`)
    if (!ok) throw new Error(`nothing matches: ${sel}`)
    await sleep(wait)
  }
  await clickSel('.ac-scripts-head')
  await shot('06-scripts-open')
  await clickSel('.ac-sr-main')
  await shot('07-confirm')
  await clickSel('.ac-sr-extra .ac-btn')
  await sleep(2500)
  await shot('08-ran')
  await clickSel('.ac-row.has-output')
  await shot('09-sections')
  await clickSel('.ac-secs-all')
  await shot('10-sections-expanded')
  await clickSel('.ac-icon[aria-label^="View"]', 1200)
  await shot('11-drawer')

  return app.exit(0)
}
