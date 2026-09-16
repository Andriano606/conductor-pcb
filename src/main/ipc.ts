import { BrowserWindow, app, clipboard, dialog, ipcMain, shell } from 'electron'
import { readFileSync, writeFileSync } from 'fs'
import { basename } from 'path'
import type { AppConfig, ChatAttachment, ClaudeProfile, CustomPrompt, EnvVar, Rule, RuleOverride } from '../shared/types'
import { exportCheckerConfig } from '../shared/rules'
import { addClaudeProfile, addCustomPrompt, getConfig, getConfigPath, removeClaudeProfile, removeCustomPrompt, setConfig, updateClaudeProfile, updateCustomPrompt } from './store'
import { deleteUserRule, getRules, reloadRules, saveUserRule, snapshot, startWatching } from './rulesRepo'
import { apiStatus, getLastReport, setLastReport, startApi } from './api'
import type { ChatAnswer, PcbProject } from '../shared/types'
import { addProjectFromDir, closeChatSession, createChatSession, deleteProject, getProject, kicadStatus, openInKicad, rebuildAllConfigs, renameChatSession, applyGlobalRulesToProject, listKernels, refreshBoards, runChecks, setProjectProfiles, setProjectRuleOverride, startSessionChat, updateProject } from './projects'
import { isClaudeConfigDir } from './configMerge'
import { pollUsage, refreshUsageSoon } from './usagePoller'
import { answerChat, attachChat, interruptChat, sendChatMessage, setChatParams } from './claudeChat'

export function registerIpc(win: BrowserWindow): void {
  ipcMain.handle('rules:snapshot', (_e, projectId?: string) => snapshot(projectId))
  ipcMain.handle('rules:setProjectOverride', (_e, projectId: string, code: string, ov: RuleOverride | null) => {
    setProjectRuleOverride(projectId, code, ov)
    return snapshot(projectId)
  })
  ipcMain.handle('rules:resetProjectOverrides', (_e, projectId: string) => {
    applyGlobalRulesToProject(projectId)
    return snapshot(projectId)
  })
  ipcMain.handle('rules:reload', () => {
    reloadRules()
    return snapshot()
  })
  ipcMain.handle('rules:kernels', (_e, force?: boolean) => listKernels(!!force))
  ipcMain.handle('rules:saveUser', (_e, rule: Rule, projectId?: string) => saveUserRule(rule, projectId))
  ipcMain.handle('rules:deleteUser', (_e, code: string, projectId?: string) => deleteUserRule(code, projectId))
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
    return p ? kicadStatus(p) : { running: false, apiSocket: false, runningBoards: [] }
  })
  ipcMain.handle('projects:boards', (_e, id: string) => {
    const p = getProject(id)
    return p ? (refreshBoards(p).boards ?? []) : []
  })
  ipcMain.handle('projects:setCheckBoards', (_e, id: string, checkBoards: Record<string, boolean>) => updateProject(id, { checkBoards }))
  ipcMain.handle('projects:openBoard', (_e, id: string, boardFile: string) => {
    const p = getProject(id)
    if (p) openInKicad(p, boardFile)
    return !!p
  })
  ipcMain.handle('projects:checkBoards', async (_e, id: string, boards: string[]) => {
    const p = getProject(id)
    if (!p) return { projectId: id, boards: [] }
    const r = await runChecks(refreshBoards(p), boards, (pr) => {
      if (!win.isDestroyed()) win.webContents.send('check:progress', pr)
    })
    win.webContents.send('projects:changed', getConfig().projects)
    return r
  })
  // ---- chat (`id` is a session/tab id, the opaque chat key)
  ipcMain.handle('chat:attach', (_e, id: string) => {
    startSessionChat(id, app.getPath('userData'))
    return attachChat(id)
  })
  ipcMain.on('chat:send', (_e, id: string, text: string, attachments?: ChatAttachment[]) => sendChatMessage(id, text, () => startSessionChat(id, app.getPath('userData')), attachments ?? []))
  ipcMain.handle('chat:setModel', (_e, id: string, model: string) => setChatParams(id, { model }))
  ipcMain.handle('chat:setEffort', (_e, id: string, effort: string) => setChatParams(id, { effort }))
  ipcMain.handle('dialog:pickFiles', async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Прикріпити файли', properties: ['openFile', 'multiSelections'] })
    return r.canceled ? [] : r.filePaths
  })
  ipcMain.on('chat:answer', (_e, id: string, answer: ChatAnswer) => answerChat(id, answer))
  ipcMain.on('chat:interrupt', (_e, id: string) => interruptChat(id))
  ipcMain.handle('chat:restart', (_e, id: string) => startSessionChat(id, app.getPath('userData'), true))
  // ---- chat sessions (tabs within a project); each change pushes the fresh project list
  const projectsChanged = (): void => win.webContents.send('projects:changed', getConfig().projects)
  ipcMain.handle('session:create', (_e, projectId: string) => {
    const session = createChatSession(projectId, app.getPath('userData'))
    projectsChanged()
    return session
  })
  ipcMain.handle('session:close', (_e, sessionId: string) => {
    const ok = closeChatSession(sessionId)
    projectsChanged()
    return ok
  })
  ipcMain.handle('session:rename', (_e, sessionId: string, title: string) => {
    renameChatSession(sessionId, title)
    projectsChanged()
  })
  // ---- prompt library
  ipcMain.handle('prompts:list', () => getConfig().customPrompts)
  ipcMain.handle('prompts:add', (_e, title: string, content: string) => addCustomPrompt(title, content))
  ipcMain.handle('prompts:update', (_e, prompt: CustomPrompt) => updateCustomPrompt(prompt))
  ipcMain.handle('prompts:remove', (_e, id: string) => removeCustomPrompt(id))
  // ---- Claude config profiles
  ipcMain.handle('profiles:list', () => getConfig().claudeProfiles)
  ipcMain.handle('profiles:add', (_e, name: string, path: string, env: EnvVar[]) => addClaudeProfile(name, path, env))
  ipcMain.handle('profiles:update', (_e, profile: ClaudeProfile) => updateClaudeProfile(profile))
  ipcMain.handle('profiles:remove', (_e, id: string) => removeClaudeProfile(id))
  ipcMain.handle('profiles:isConfigDir', (_e, dir: string) => isClaudeConfigDir(dir))
  ipcMain.handle('profiles:setForProject', (_e, projectId: string, ids: string[]) => setProjectProfiles(projectId, ids, app.getPath('userData')))
  ipcMain.handle('profiles:rebuild', () => rebuildAllConfigs(app.getPath('userData')))
  // ---- usage
  ipcMain.handle('usage:get', () => getConfig().lastUsage)
  ipcMain.on('usage:refresh', (_e, force?: boolean) => (force ? pollUsage() : refreshUsageSoon()))
  ipcMain.handle('sys:homeDir', () => app.getPath('home'))
  ipcMain.on('sys:copy', (_e, text: string) => clipboard.writeText(text))
  ipcMain.on('sys:openExternal', (_e, url: string) => void shell.openExternal(url))
}
