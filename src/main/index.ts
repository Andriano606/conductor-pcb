import { app, BrowserWindow, Menu, shell } from 'electron'
import { join } from 'path'
import { initStore } from './store'
import { registerIpc } from './ipc'
import { onRulesChanged, reloadRules, snapshot, startWatching, stopWatching } from './rulesRepo'
import { apiStatus, setConfigListener, setReportListener, setScreenshotProvider, startApi, stopApi } from './api'
import { writeFileSync } from 'fs'
import { killAllChats, onChatBusy, onChatEvent, onChatParams, onChatSessionId, setChatStorageDir } from './claudeChat'
import { patchSession, reconcileProjectOverrides } from './projects'
import { onUsage, startUsagePolling, stopUsagePolling } from './usagePoller'
import { getConfig, setConfig } from './store'

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 560,
    backgroundColor: '#1b1d23',
    title: 'Conductor PCB',
    autoHideMenuBar: true,
    icon: join(app.getAppPath(), 'build', 'icon.png'),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  // Surface renderer console errors in the main log (dev troubleshooting).
  win.webContents.on('console-message', (_e, level, message, line, source) => {
    if (level >= 2) console.log(`[renderer] ${message} (${source.split('/').pop()}:${line})`)
  })
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })
  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
  return win
}

void app.whenReady().then(async () => {
  Menu.setApplicationMenu(null)
  initStore()
  reloadRules()
  startWatching()
  setChatStorageDir(join(app.getPath('userData'), 'chats'))
  const win = createWindow()
  registerIpc(win)
  onChatEvent((id, seq, ev) => {
    if (!win.isDestroyed()) win.webContents.send('chat:event', { id, seq, ev })
  })
  // `id` is a session (tab) id: the chat key persists its Claude session id and model knobs on that tab.
  onChatSessionId((id, sessionId) => patchSession(id, { claudeSessionId: sessionId || undefined }))
  onChatParams((id, params) => patchSession(id, { claudeModel: params.model, claudeEffort: params.effort }))
  onChatBusy((id, busy) => {
    if (!win.isDestroyed()) win.webContents.send('chat:busy', { id, busy })
  })
  onUsage((windows) => {
    setConfig({ lastUsage: windows })
    if (!win.isDestroyed()) win.webContents.send('claude:usage', windows)
  })
  startUsagePolling()
  onRulesChanged(() => {
    // rule files changed → defaults may have moved; project overrides that now match the globals go away
    if (reconcileProjectOverrides() && !win.isDestroyed()) win.webContents.send('config:changed', getConfig())
    if (!win.isDestroyed()) win.webContents.send('rules:changed', snapshot())
  })
  setReportListener((report) => {
    if (!win.isDestroyed()) win.webContents.send('findings:new', report)
  })
  setScreenshotProvider(async (view) => {
    if (view) {
      win.webContents.send('ui:setView', view)
      await new Promise((r) => setTimeout(r, 400))
    }
    const img = await win.webContents.capturePage()
    const file = join(app.getPath('temp'), 'conductor-pcb-screenshot.png')
    writeFileSync(file, img.toPNG())
    return file
  })
  setConfigListener((cfg) => {
    // the HTTP API may have patched the global overrides
    const next = reconcileProjectOverrides() ? getConfig() : cfg
    if (!win.isDestroyed()) win.webContents.send('config:changed', next)
  })
  const st = await startApi(app.getVersion())
  win.webContents.on('did-finish-load', () => {
    win.webContents.send('api:status', { ...apiStatus(), error: st.error })
  })
  if (!st.ok && st.error !== 'disabled') console.error('API failed to start:', st.error)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  stopUsagePolling()
  stopWatching()
  stopApi()
  killAllChats()
  app.quit()
})
app.on('before-quit', () => killAllChats())
