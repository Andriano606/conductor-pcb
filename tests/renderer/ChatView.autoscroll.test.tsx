// @vitest-environment jsdom
import React from 'react'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatView } from '../../src/renderer/src/components/ChatView'
import { useChatStore } from '../../src/renderer/src/chatStore'
import { useStore } from '../../src/renderer/src/store'
import type { ChatItem, PcbProject } from '@shared/types'

/**
 * Auto-follow («примагнічування») of the transcript to the newest message, ported from conductor-linux.
 * jsdom has no layout, so the scroller gets a fake scrollHeight/clientHeight and a clamped scrollTop;
 * everything the pin does — hold, detach, re-attach, restore — is then observable as plain `scrollTop`.
 */
const LAYOUT = { scrollHeight: 1000, clientHeight: 200 }
const BOTTOM = LAYOUT.scrollHeight - LAYOUT.clientHeight

const s1 = { id: 's1', createdAt: 1 }
const s2 = { id: 's2', createdAt: 2 }
const project: PcbProject = { id: 'p1', name: 'board', dir: '/x/board', proFile: '/x/board/board.kicad_pro', boardFile: '/x/board/board.kicad_pcb', createdAt: 1, sessions: [s1, s2] }
const msg = (id: string, text: string): ChatItem => ({ id, role: 'assistant', text, ts: 0 })

const api = {
  attachChat: vi.fn(),
  kicadStatus: vi.fn().mockResolvedValue({ running: true, apiSocket: true }),
  sendChat: vi.fn(),
  answerChat: vi.fn(),
  interruptChat: vi.fn(),
  openKicad: vi.fn(),
  pickFiles: vi.fn().mockResolvedValue([]),
  pathForFile: () => ''
}

/**
 * Fake layout for the `.chat-scroll` element only, installed on the prototype so it is in place
 * before ChatView's mount effect touches scrollTop (a per-node override would come too late).
 */
const tops = new WeakMap<Element, number>()
const isScroller = (el: Element): boolean => el.classList?.contains('chat-scroll')
const proto = HTMLElement.prototype as unknown as Record<string, unknown>
const orig = {
  scrollHeight: Object.getOwnPropertyDescriptor(Element.prototype, 'scrollHeight'),
  clientHeight: Object.getOwnPropertyDescriptor(Element.prototype, 'clientHeight'),
  scrollTop: Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop')
}
beforeAll(() => {
  Object.defineProperties(proto, {
    scrollHeight: { configurable: true, get() { return isScroller(this as Element) ? LAYOUT.scrollHeight : orig.scrollHeight?.get?.call(this) },
    },
    clientHeight: { configurable: true, get() { return isScroller(this as Element) ? LAYOUT.clientHeight : orig.clientHeight?.get?.call(this) } },
    scrollTop: {
      configurable: true,
      get() { return isScroller(this as Element) ? tops.get(this as Element) ?? 0 : orig.scrollTop?.get?.call(this) },
      set(v: number) {
        if (isScroller(this as Element)) tops.set(this as Element, Math.max(0, Math.min(v, BOTTOM)))
        else orig.scrollTop?.set?.call(this, v)
      }
    }
  })
})
afterAll(() => {
  for (const k of ['scrollHeight', 'clientHeight', 'scrollTop'] as const) delete proto[k]
})
const scroller = (): HTMLElement => document.querySelector('.chat-scroll') as HTMLElement
const settle = async (): Promise<void> => act(async () => { await new Promise((r) => setTimeout(r, 160)) })

let seq = 0
async function claudeSays(sessionId: string, text: string): Promise<void> {
  await act(async () => {
    useChatStore.getState().applyEvent({ id: sessionId, seq: ++seq, ev: { type: 'push', item: msg(`m${seq}`, text) } })
  })
  await settle()
}
/** The user wheels the transcript up by hand. */
async function wheelUp(): Promise<void> {
  await act(async () => {
    const el = scroller()
    el.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, bubbles: true }))
    el.scrollTop = 300
    el.dispatchEvent(new Event('scroll'))
  })
}
/** Layout — not the user — moves scrollTop up (a re-measured row); no gesture precedes it. */
async function layoutCorrection(): Promise<void> {
  await act(async () => { await new Promise((r) => setTimeout(r, 450)) })
  await act(async () => {
    const el = scroller()
    el.scrollTop = 640
    el.dispatchEvent(new Event('scroll'))
  })
}
async function open(session: { id: string; createdAt: number }, items: ChatItem[]): Promise<ReturnType<typeof render>> {
  api.attachChat.mockResolvedValue({ items, pending: null, busy: false, seq, running: true })
  const r = render(<ChatView project={project} session={session} key={session.id} />)
  await screen.findByPlaceholderText(/Що змінити на платі/)
  await settle()
  return r
}

describe('ChatView auto-follow', () => {
  beforeEach(() => {
    ;(window as unknown as { api: unknown }).api = api
    useChatStore.setState({ chats: {}, drafts: {}, attachments: {} })
    useStore.setState({ kicad: {}, checking: {} })
    seq = 0
    api.sendChat.mockClear()
  })

  it('follows new messages and holds the pin through a layout scroll correction', async () => {
    await open(s1, [msg('m0', 'перше')])
    await claudeSays('s1', 'друге')
    expect(scroller().scrollTop).toBe(BOTTOM)
    await layoutCorrection()
    expect(scroller().scrollTop).toBe(BOTTOM) // re-snapped right away, no gesture
    await claudeSays('s1', 'третє')
    expect(scroller().scrollTop).toBe(BOTTOM)
  })

  it('a wheel-up detaches the pin so the user can read back while Claude keeps adding', async () => {
    await open(s1, [msg('m0', 'перше')])
    await wheelUp()
    await claudeSays('s1', 'друге')
    await act(async () => {
      useChatStore.getState().applyEvent({ id: 's1', seq: ++seq, ev: { type: 'append', itemId: `m${seq - 1}`, text: ' і ще' } })
    })
    await settle()
    expect(scroller().scrollTop).toBe(300)
  })

  it('scrolling back to the bottom re-attaches the pin', async () => {
    await open(s1, [msg('m0', 'перше')])
    await wheelUp()
    await act(async () => {
      const el = scroller()
      el.scrollTop = BOTTOM
      el.dispatchEvent(new Event('scroll'))
    })
    await wheelDownNoop()
    await claudeSays('s1', 'друге')
    expect(scroller().scrollTop).toBe(BOTTOM)
  })

  it('sending re-pins even after the user scrolled up', async () => {
    await open(s1, [msg('m0', 'перше')])
    await wheelUp()
    expect(scroller().scrollTop).toBe(300)
    const ta = screen.getByPlaceholderText(/Що змінити на платі/)
    fireEvent.change(ta, { target: { value: 'ще одне' } })
    fireEvent.keyDown(ta, { key: 'Enter' })
    expect(api.sendChat).toHaveBeenCalledWith('s1', 'ще одне')
    await claudeSays('s1', 'відповідь')
    expect(scroller().scrollTop).toBe(BOTTOM)
  })

  it('a session left scrolled up reopens where it was; one left pinned reopens at the newest message', async () => {
    const r1 = await open(s1, [msg('m0', 'перше')])
    await wheelUp()
    r1.unmount()
    const r2 = await open(s2, [msg('x', 'інша сесія')])
    expect(scroller().scrollTop).toBe(BOTTOM)
    await claudeSays('s2', 'ще')
    r2.unmount()
    // s1 was left at 300 and unpinned
    await open(s1, [msg('m0', 'перше')])
    expect(scroller().scrollTop).toBe(300)
  })
})

/** A downward wheel never detaches; here it only opens the gesture window with no scroll. */
async function wheelDownNoop(): Promise<void> {
  await act(async () => {
    scroller().dispatchEvent(new WheelEvent('wheel', { deltaY: 120, bubbles: true }))
  })
}
