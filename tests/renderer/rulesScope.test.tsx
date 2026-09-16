// @vitest-environment jsdom
import React from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { applyOverride } from '@shared/rules'
import type { PcbProject, RulesSnapshot } from '@shared/types'
import { sampleRule } from '../helpers/sample'
import { scopeFor, useStore } from '../../src/renderer/src/store'
import { GlobalRulesModal } from '../../src/renderer/src/components/GlobalRulesModal'
import { RuleSidebar } from '../../src/renderer/src/components/RuleSidebar'
import { ImportRuleModal } from '../../src/renderer/src/components/ImportRuleModal'
import { RuleView } from '../../src/renderer/src/components/RuleView'
import { TopBar } from '../../src/renderer/src/components/TopBar'

const p1: PcbProject = { id: 'p1', name: 'board', dir: '/x', proFile: '', boardFile: '', createdAt: 1, sessions: [{ id: 'p1', createdAt: 1 }] }
const ruleA = sampleRule({ code: 'A_RULE', title: 'Rule A' })
const ruleB = sampleRule({ code: 'B_RULE', title: 'Rule B', category: 'ground' })
const snap = (rules: RulesSnapshot['rules'], projectId?: string): RulesSnapshot => ({ rules, errors: [], bundledDir: '/b', userRulesDir: '/u', ...(projectId ? { projectId, projectRulesDir: `/pr/${projectId}` } : {}) })

function mockApi(): Record<string, ReturnType<typeof vi.fn>> {
  const api = {
    getRules: vi.fn().mockImplementation((pid?: string) => Promise.resolve(pid ? snap([applyOverride(ruleA, { enabled: true }), applyOverride(ruleB, undefined)], pid) : snap([applyOverride(ruleA, { enabled: false }), applyOverride(ruleB, undefined)]))),
    setConfig: vi.fn().mockImplementation((patch) => Promise.resolve({ activeProjectId: 'p1', overrides: patch.overrides ?? {}, projects: [p1] })),
    getConfig: vi.fn().mockResolvedValue({ activeProjectId: 'p1', overrides: {}, projects: [p1] }),
    setProjectOverride: vi.fn().mockResolvedValue(snap([], 'p1')),
    saveUserRule: vi.fn().mockResolvedValue([]),
    deleteUserRule: vi.fn().mockResolvedValue(true),
    reloadRules: vi.fn().mockResolvedValue(undefined),
    pickJsonFile: vi.fn(),
    copyText: vi.fn(),
    openExternal: vi.fn(),
    openRuleFile: vi.fn()
  }
  ;(window as unknown as { api: unknown }).api = api
  return api
}

describe('rules scope', () => {
  beforeEach(() => {
    useStore.setState({
      config: { activeProjectId: 'p1', overrides: {}, projects: [p1] } as never,
      projects: [p1],
      ruleScope: 'p1',
      rules: [applyOverride(ruleA, { enabled: true }), applyOverride(ruleB, undefined)],
      globalRules: [applyOverride(ruleA, { enabled: false }), applyOverride(ruleB, undefined)],
      errors: [],
      report: null,
      importScope: null,
      globalRulesOpen: false,
      selected: 'A_RULE',
      confirm: null
    })
  })
  it('scopeFor picks the active project, falls back to the first one, then global', () => {
    expect(scopeFor({ activeProjectId: 'p1' }, [p1])).toBe('p1')
    expect(scopeFor({ activeProjectId: 'gone' }, [p1])).toBe('p1')
    expect(scopeFor(null, [])).toBe('global')
  })
  it('refreshRules fetches the project scope and the global library', async () => {
    const api = mockApi()
    await useStore.getState().refreshRules()
    expect(api.getRules.mock.calls).toEqual([['p1'], []])
    const st = useStore.getState()
    expect(st.ruleScope).toBe('p1')
    expect(st.projectRulesDir).toBe('/pr/p1')
    expect(st.rules.find((r) => r.code === 'A_RULE')?.effective.enabled).toBe(true)
    expect(st.globalRules.find((r) => r.code === 'A_RULE')?.effective.enabled).toBe(false)
  })
  it('setOverride writes global overrides or the project override depending on scope', async () => {
    const api = mockApi()
    await useStore.getState().setOverride('A_RULE', { enabled: true }, 'global')
    expect(api.setConfig).toHaveBeenCalledWith({ overrides: { A_RULE: { enabled: true } } })
    expect(api.setProjectOverride).not.toHaveBeenCalled()
    await useStore.getState().setOverride('A_RULE', { enabled: false }) // default: the tab's scope = p1
    expect(api.setProjectOverride).toHaveBeenCalledWith('p1', 'A_RULE', { enabled: false })
    await useStore.getState().resetOverride('A_RULE')
    expect(api.setProjectOverride).toHaveBeenCalledWith('p1', 'A_RULE', null)
  })
  it('a pushed global snapshot keeps the tab on the project scope', async () => {
    const api = mockApi()
    useStore.getState().applySnapshot(snap([applyOverride(ruleA, { enabled: false })]))
    await vi.waitFor(() => expect(api.getRules).toHaveBeenCalledWith('p1'))
    await vi.waitFor(() => expect(useStore.getState().rules.find((r) => r.code === 'A_RULE')?.effective.enabled).toBe(true))
    expect(useStore.getState().globalRules.find((r) => r.code === 'A_RULE')?.effective.enabled).toBe(false)
  })
  it('the «Правила» tab counts the rules enabled for the current project', async () => {
    mockApi()
    useStore.setState({ api: { running: false, url: '' } as never })
    render(<TopBar />)
    expect(screen.getByLabelText('Увімкнено 2 з 2 правил для проекту board')).toHaveTextContent('2')
    useStore.setState({ rules: [applyOverride(ruleA, { enabled: false }), applyOverride(ruleB, undefined)] })
    expect(await screen.findByLabelText('Увімкнено 1 з 2 правил для проекту board')).toHaveTextContent('1')
  })
  it('the rules tab sidebar names the project, toggles rules for it and imports into its scope', async () => {
    const api = mockApi()
    render(<RuleSidebar rules={useStore.getState().rules} />)
    expect(screen.getByText('board')).toBeInTheDocument()
    // ↺ next to import resets the selected rule's project override, enabled only when there is one
    expect(screen.getByLabelText('Скинути A_RULE до типових')).toBeDisabled()
    useStore.setState({ projects: [{ ...p1, ruleOverrides: { A_RULE: { enabled: false } } }] })
    await vi.waitFor(() => expect(screen.getByLabelText('Скинути A_RULE до типових')).toBeEnabled())
    fireEvent.click(screen.getByLabelText('Скинути A_RULE до типових'))
    await vi.waitFor(() => expect(api.setProjectOverride).toHaveBeenCalledWith('p1', 'A_RULE', null))
    fireEvent.click(screen.getByLabelText('Увімкнути A_RULE для проекту board'))
    await vi.waitFor(() => expect(api.setProjectOverride).toHaveBeenCalledWith('p1', 'A_RULE', { enabled: false }))
    expect(api.setConfig).not.toHaveBeenCalled()
    expect(screen.queryByLabelText('Область правил')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Налаштування')).not.toBeInTheDocument() // settings live in the sidebar footer / global window
    fireEvent.click(screen.getByLabelText('Імпортувати правило'))
    expect(useStore.getState().importScope).toBe('p1')
    fireEvent.click(screen.getByText('глобальні…'))
    expect(useStore.getState().globalRulesOpen).toBe(true)
  })
  it('the global rules window toggles defaults for all projects and imports globally', async () => {
    const api = mockApi()
    render(<GlobalRulesModal />)
    expect(screen.getByText('Глобальні правила')).toBeInTheDocument()
    expect(screen.getByText(/увімкнено для всіх проектів: 1 з 2/)).toBeInTheDocument()
    fireEvent.click(screen.getByLabelText('Увімкнути A_RULE для всіх проектів'))
    await vi.waitFor(() => expect(api.setConfig).toHaveBeenCalledWith({ overrides: { A_RULE: { enabled: true } } }))
    expect(api.setProjectOverride).not.toHaveBeenCalled()
    fireEvent.click(screen.getByText('Імпортувати правило…'))
    expect(useStore.getState().importScope).toBe('global')
    fireEvent.click(screen.getByText('Rule B'))
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Rule B')
    expect(screen.queryByText('як у глобальних')).not.toBeInTheDocument()
    expect(screen.queryByLabelText(/Скинути .* до типових/)).not.toBeInTheDocument() // no reset in the global window
  })
  it('the import modal stacks above the global rules window', () => {
    mockApi()
    render(<><GlobalRulesModal /><ImportRuleModal scope="global" /></>)
    const backdrops = Array.from(document.querySelectorAll('.modal-backdrop'))
    expect(backdrops).toHaveLength(2)
    expect(backdrops[1].classList.contains('stacked')).toBe(true) // rendered after, with the higher z-index class
    expect(backdrops[0].classList.contains('stacked')).toBe(false)
  })
  it('imports save into the project dir or the user dir by scope', async () => {
    const api = mockApi()
    const { unmount } = render(<ImportRuleModal scope="p1" />)
    expect(screen.getByText(/для проекту board/)).toBeInTheDocument()
    fireEvent.change(screen.getByPlaceholderText(/"code"/), { target: { value: JSON.stringify(sampleRule({ code: 'NEW_ONE' })) } })
    fireEvent.click(screen.getByText('Зберегти правило'))
    await vi.waitFor(() => expect(api.saveUserRule).toHaveBeenCalledWith(expect.objectContaining({ code: 'NEW_ONE' }), 'p1'))
    await vi.waitFor(() => expect(useStore.getState().importScope).toBeNull())
    unmount()
    useStore.setState({ importScope: 'global' })
    render(<ImportRuleModal scope="global" />)
    expect(screen.getByText('Імпортувати глобальне правило')).toBeInTheDocument()
    fireEvent.change(screen.getByPlaceholderText(/"code"/), { target: { value: JSON.stringify(sampleRule({ code: 'NEW_TWO' })) } })
    fireEvent.click(screen.getByText('Зберегти правило'))
    await vi.waitFor(() => expect(api.saveUserRule).toHaveBeenCalledWith(expect.objectContaining({ code: 'NEW_TWO' }), undefined))
  })
  it('the rule card shows inheritance, resets a project override and deletes project rules', async () => {
    const api = mockApi()
    const { rerender } = render(<RuleView rule={applyOverride(ruleA, undefined)} />)
    expect(screen.getByText('як у глобальних')).toBeInTheDocument()
    expect(screen.queryByRole('switch')).not.toBeInTheDocument() // enabling lives in the sidebar now
    expect(screen.queryByText('Скинути до типових')).not.toBeInTheDocument() // the ↺ icon lives next to import
    useStore.setState({ projects: [{ ...p1, ruleOverrides: { A_RULE: { enabled: false } } }] })
    rerender(<RuleView rule={applyOverride(ruleA, { enabled: false })} />)
    expect(await screen.findByText('змінено для board')).toBeInTheDocument()
    rerender(<RuleView rule={applyOverride({ ...ruleA, source: 'project', file: '/pr/p1/A_RULE.json' }, undefined)} />)
    expect(screen.getByText('лише цей проект')).toBeInTheDocument()
    fireEvent.click(screen.getByText('видалити правило'))
    await vi.waitFor(() => expect(useStore.getState().confirm).not.toBeNull())
    useStore.getState().resolveConfirm(true)
    await vi.waitFor(() => expect(api.deleteUserRule).toHaveBeenCalledWith('A_RULE', 'p1'))
  })
})
