// @vitest-environment jsdom
import React from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { PromptLibraryModal } from '../../src/renderer/src/components/PromptLibraryModal'
import { UsageMeters, resetsIn } from '../../src/renderer/src/components/UsageMeters'
import { useStore } from '../../src/renderer/src/store'

describe('PromptLibraryModal', () => {
  beforeEach(() => {
    ;(window as unknown as { api: unknown }).api = { refreshUsage: vi.fn() }
  })
  it('lists prompts, inserts one, and creates a new one', async () => {
    const create = vi.fn().mockResolvedValue(undefined)
    const onInsert = vi.fn()
    useStore.setState({ customPrompts: [{ id: 'p', title: 'Перевірка', content: 'Перевір $PCB_PROJECT_NAME', createdAt: 0, updatedAt: 0 }], createCustomPrompt: create })
    render(<PromptLibraryModal onInsert={onInsert} onClose={() => {}} project={{ id: 'x', name: 'brd', dir: '/d', proFile: '', boardFile: '/d/b.kicad_pcb', createdAt: 0, sessions: [] }} />)
    expect(screen.getByText('Перевірка')).toBeInTheDocument()
    fireEvent.click(screen.getByTitle('Вставити в поле вводу'))
    expect(onInsert).toHaveBeenCalledWith('Перевір $PCB_PROJECT_NAME')
    fireEvent.change(screen.getByPlaceholderText('Назва'), { target: { value: 'Новий' } })
    fireEvent.change(screen.getByPlaceholderText(/Текст промту/), { target: { value: 'тіло' } })
    fireEvent.click(screen.getByText('Додати'))
    expect(create).toHaveBeenCalledWith('Новий', 'тіло')
  })
})

describe('UsageMeters', () => {
  it('renders bars with levels and hides when empty', () => {
    useStore.setState({ usage: [] })
    const { container, rerender } = render(<UsageMeters />)
    expect(container.querySelector('.usage-meters')).toBeNull()
    useStore.setState({ usage: [{ key: 'session', label: 'Сесія', percent: 92, resetsAt: Math.floor(Date.now() / 1000) + 3700 }, { key: 'week_all', label: 'Тиждень', percent: 40 }, { key: 'week_sonnet', label: 'S', percent: 1 }] })
    rerender(<UsageMeters />)
    expect(container.querySelectorAll('.usage-item')).toHaveLength(2)
    expect(container.querySelector('.usage-fill.high')).not.toBeNull()
    expect(screen.getByText('92%')).toBeInTheDocument()
    expect(screen.getByText(/Оновиться через 1г/)).toBeInTheDocument()
  })
  it('resetsIn formats days/hours/minutes', () => {
    const now = 1_000_000_000_000
    expect(resetsIn(undefined, now)).toBeNull()
    expect(resetsIn(now / 1000 + 90_000, now)).toBe('1д 1г')
    expect(resetsIn(now / 1000 + 120, now)).toBe('2хв')
  })
})
