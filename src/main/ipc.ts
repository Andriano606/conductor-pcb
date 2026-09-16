import { BrowserWindow, app, clipboard, dialog, ipcMain, shell } from 'electron'
import { readFileSync, writeFileSync } from 'fs'
import { basename } from 'path'
import type { AppConfig, ChatAttachment, Rule, RuleOverride } from '../shared/types'
import { exportCheckerConfig, withProjectOverride } from '../shared/rules'
import { getConfig, getConfigPath, setConfig } from './store'
import { deleteUserRule, getRules, reloadRules, saveUserRule, snapshot, startWatching } from './rulesRepo'
import { apiStatus, getLastReport, setLastReport, startApi } from './api'
import type { ChatAnswer, PcbProject } from '../shared/types'
import { addProjectFromDir, deleteProject, getProject, kicadStatus, openInKicad, runCheck, startProjectChat, updateProject } from './projects'
import { answerChat, attachChat, clearChat, interruptChat, killChat, sendChatMessage, setChatParams } from './claudeChat'

export function registerIpc(win: BrowserWindow): void {
  ipcMain.handle('rules:snapshot', (_e, projectId?: string) => snapshot(projectId))
  ipcMain.handle('rules:setProjectOverride', (_e, projectId: string, code: string, ov: RuleOverride | null) => {
    setConfig({ projects: withProjectOverride(getConfig().projects, projectId, code, ov) })
    return snapshot(projectId)
  })
  ipcMain.handle('rules:reload', () => {
    reloadRules()
    return snapshot()
  })
  ipcMain.handle('rules:saveUser', (_e, rule: Rule) => saveUserRule(rule))
  ipcMain.handle('rules:deleteUser', (_e, code: string) => deleteUserRule(code))
  ipcMain.handle('rules:openFile', (_e, file: string) => shell.openPath(file))
  ipcMain.handle('rules:showDir', (_e, dir: string) => shell.openPath(dir))

  ipcMain.handle('config:get', () => getConfig())
  ipcMain.handle('config:set', async (_e, patch: Partial<AppConfig>) => {
    const before = getConfig()
    const next = setConfig(patch)
    if (patch.userRulesDir && patch.userRulesDir !== before.userRulesDir) {
      startWatching()
      reloadRules()
    }
    if (patch.api && (patch.api.port !== before.api.port || patch.api.enabled !== before.api.enabled || patch.api.host !== before.api.host)) {
      const st = await startApi(app.getVersion())
      win.webContents.send('api:status', { ...apiStatus(), error: st.error })
    }
    return next
  })
  ipcMain.handle('config:path', () => getConfigPath())

  ipcMain.handle('api:status', () => apiStatus())
  ipcMain.handle('export:checker', (_e, projectId?: string) => exportCheckerConfig(getRules(projectId)))
  ipcMain.handle('export:save', async (_e, defaultPath?: string) => {
    const r = await dialog.showSaveDialog(win, {
      title: 'Зберегти конфіг перевіряча',
      defaultPath: defaultPath || getConfig().exportPath || 'pcbagent.rules.json',
      filters: [{ name: 'JSON', extensions: ['json'] }]
    })
    if (r.canceled || !r.filePath) return null
    writeFileSync(r.filePath, JSON.stringify(exportCheckerConfig(getRules()), null, 2))
    setConfig({ exportPath: r.filePath })
    return r.filePath
  })
  ipcMain.handle('findings:last', () => getLastReport())
  ipcMain.handle('findings:clear', () => setLastReport(null))
  ipcMain.handle('dialog:pickJsonFile', async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Файл правила', properties: ['openFile'], filters: [{ name: 'JSON', extensions: ['json'] }] })
    if (r.canceled || !r.filePaths[0]) return null
    const file = r.filePaths[0]
    return { name: basename(file), content: readFileSync(file, 'utf8') }
  })
  ipcMain.handle('dialog:pickDir', async (_e, defaultPath?: string) => {
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'], defaultPath })
    return r.canceled ? null : r.filePaths[0]
  })
  // ---- projects
  ipcMain.handle('projects:list', () => getConfig().projects)
  ipcMain.handle('projects:add', async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Папка проекту KiCad', properties: ['openDirectory'] })
    if (r.canceled || !r.filePaths[0]) return null
    const p = addProjectFromDir(r.filePaths[0])
    if (!p) return { error: 'У цій папці немає файлу .kicad_pro або .kicad_pcb' }
    return p
  })
  ipcMain.handle('projects:addDir', (_e, dir: string) => addProjectFromDir(dir))
  ipcMain.handle('projects:delete', (_e, id: string) => deleteProject(id))
  ipcMain.handle('projects:update', (_e, id: string, patch: Partial<PcbProject>) => updateProject(id, patch))
  ipcMain.handle('projects:select', (_e, id: string) => setConfig({ activeProjectId: id }))
  ipcMain.handle('projects:openKicad', (_e, id: string) => {
    const p = getProject(id)
    if (p) openInKicad(p)
    return !!p
  })
  ipcMain.handle('projects:kicadStatus', (_e, id: string) => {
    const p = getProject(id)
    return p ? kicadStatus(p) : { running: false, apiSocket: false }
  })
  ipcMain.handle('projects:check', async (_e, id: string) => {
    const p = getProject(id)
    if (!p) return { ok: false, error: 'проект не знайдено' }
    const r = await runCheck(p)
    win.webContents.send('projects:changed', getConfig().projects)
    return r
  })
  // ---- chat
  ipcMain.handle('chat:attach', (_e, id: string) => {
    startProjectChat(id, app.getPath('userData'))
    return attachChat(id)
  })
  ipcMain.on('chat:send', (_e, id: string, text: string, attachments?: ChatAttachment[]) => sendChatMessage(id, text, () => startProjectChat(id, app.getPath('userData')), attachments ?? []))
  ipcMain.handle('chat:setModel', (_e, id: string, model: string) => setChatParams(id, { model }))
  ipcMain.handle('chat:setEffort', (_e, id: string, effort: string) => setChatParams(id, { effort }))
  ipcMain.handle('dialog:pickFiles', async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Прикріпити файли', properties: ['openFile', 'multiSelections'] })
    return r.canceled ? [] : r.filePaths
  })
  ipcMain.on('chat:answer', (_e, id: string, answer: ChatAnswer) => answerChat(id, answer))
  ipcMain.on('chat:interrupt', (_e, id: string) => interruptChat(id))
  ipcMain.handle('chat:restart', (_e, id: string) => startProjectChat(id, app.getPath('userData'), true))
  ipcMain.handle('chat:clear', (_e, id: string) => {
    killChat(id)
    updateProject(id, { claudeSessionId: undefined })
    clearChat(id)
    startProjectChat(id, app.getPath('userData'))
  })
  ipcMain.on('sys:copy', (_e, text: string) => clipboard.writeText(text))
  ipcMain.on('sys:openExternal', (_e, url: string) => void shell.openExternal(url))
}
