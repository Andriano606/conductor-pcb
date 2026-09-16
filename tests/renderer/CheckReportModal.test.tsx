// @vitest-environment jsdom
import React from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CheckReportModal } from '../../src/renderer/src/components/CheckReportModal'
import { useChatStore } from '../../src/renderer/src/chatStore'
import { useStore } from '../../src/renderer/src/store'
import type { FindingsReport } from '@shared/types'

const report: FindingsReport = {
  board: '/x/board/board.kicad_pcb',
  generated: '2026-09-17T10:00:00',
  summary: { error: 1, warning: 0, info: 0 },
  findings: [{ code: 'DECOUPLING_FAR', severity: 'error', title: 'C3 далеко від U1', detail: '4.2 мм', net: 'VDD', layer: 'F.Cu', x: 10, y: 20 }]
}

describe('CheckReportModal', () => {
  const api = { sendChat: vi.fn() }
  beforeEach(() => {
    ;(window as unknown as { api: unknown }).api = api
    useChatStore.setState({ attachments: {}, drafts: {} })
    useStore.setState({ checkResult: null })
  })
  it('renders nothing without a finished check', () => {
    render(<CheckReportModal sessionId="s1" />)
    expect(screen.queryByText('Звіт перевірки')).not.toBeInTheDocument()
  })
  it('shows the findings and stages pcb_report.md in the current chat without sending', () => {
    useStore.setState({ checkResult: { ok: true, projectId: 'p1', report, reportFile: '/x/board/pcb_report.md' } })
    render(<CheckReportModal sessionId="s1" />)
    expect(screen.getByText('Звіт перевірки')).toBeInTheDocument()
    expect(screen.getByText('DECOUPLING_FAR')).toBeInTheDocument()
    expect(screen.getByText('C3 далеко від U1')).toBeInTheDocument()
    expect(screen.getByText('Ланцюг: VDD')).toBeInTheDocument()
    fireEvent.click(screen.getByText('Вставити файл у чат'))
    const atts = useChatStore.getState().attachments.s1
    expect(atts).toHaveLength(1)
    expect(atts[0]).toMatchObject({ kind: 'file', name: 'pcb_report.md', path: '/x/board/pcb_report.md' })
    expect(api.sendChat).not.toHaveBeenCalled()
    expect(useStore.getState().checkResult).toBeNull()
    expect(screen.queryByText('Звіт перевірки')).not.toBeInTheDocument()
  })
  it('does not stage the same report twice and keeps other attachments', () => {
    useChatStore.setState({ attachments: { s1: [{ id: 'a', kind: 'file', name: 'x.txt', path: '/x/x.txt' }, { id: 'b', kind: 'file', name: 'pcb_report.md', path: '/x/board/pcb_report.md' }] } })
    useStore.setState({ checkResult: { ok: true, projectId: 'p1', report, reportFile: '/x/board/pcb_report.md' } })
    render(<CheckReportModal sessionId="s1" />)
    fireEvent.click(screen.getByText('Вставити файл у чат'))
    expect(useChatStore.getState().attachments.s1.map((a) => a.id)).toEqual(['a', 'b'])
  })
  it('disables the insert button when the report file is missing and reports a clean board', () => {
    useStore.setState({ checkResult: { ok: true, projectId: 'p1', report: { ...report, summary: { error: 0, warning: 0, info: 0 }, findings: [] } } })
    render(<CheckReportModal sessionId="s1" />)
    expect(screen.getByText(/Знахідок немає/)).toBeInTheDocument()
    expect(screen.getByText('Вставити файл у чат')).toBeDisabled()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(useStore.getState().checkResult).toBeNull()
  })
})
