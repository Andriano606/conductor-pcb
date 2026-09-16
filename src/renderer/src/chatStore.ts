import { create } from 'zustand'
import type { ChatAttachment, ChatCommand, ChatEventPayload, ChatItem, ChatModelState, ChatPending, ChatSnapshot } from '@shared/types'

/** Per-project mirror of the main-side transcript (main is the source of truth). */
interface ChatEntry {
  items: ChatItem[]
  pending: ChatPending | null
  busy: boolean
  seq: number
  running: boolean
  commands: ChatCommand[]
  modelState: ChatModelState | null
}

const HISTORY_KEY = 'conductor-pcb.inputHistory'
const MAX_HISTORY = 200

function loadHistory(): string[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY)
    const arr = raw ? (JSON.parse(raw) as unknown) : []
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

interface ChatState {
  chats: Record<string, ChatEntry>
  drafts: Record<string, string>
  attachments: Record<string, ChatAttachment[]>
  inputHistory: string[]
  attach: (id: string) => Promise<void>
  applyEvent: (p: ChatEventPayload) => void
  setDraft: (id: string, text: string) => void
  setAttachments: (id: string, atts: ChatAttachment[]) => void
  pushInputHistory: (text: string) => void
}

const empty = (): ChatEntry => ({ items: [], pending: null, busy: false, seq: 0, running: false, commands: [], modelState: null })

export const useChatStore = create<ChatState>((set, get) => ({
  chats: {},
  drafts: {},
  attachments: {},
  inputHistory: loadHistory(),
  attach: async (id) => {
    const snap: ChatSnapshot = await window.api.attachChat(id)
    set({ chats: { ...get().chats, [id]: { ...empty(), ...snap, commands: snap.commands ?? [], modelState: snap.modelState ?? null } } })
  },
  applyEvent: (p) => {
    const cur = get().chats[p.id] ?? empty()
    if (p.seq <= cur.seq) return
    if (p.seq > cur.seq + 1) {
      void get().attach(p.id) // gap: resync
      return
    }
    const next: ChatEntry = { ...cur, seq: p.seq, items: cur.items }
    const ev = p.ev
    switch (ev.type) {
      case 'push':
        next.items = [...cur.items, ev.item]
        break
      case 'append':
        next.items = cur.items.map((it) => (it.id === ev.itemId ? { ...it, text: it.text + ev.text } : it))
        break
      case 'update':
        next.items = cur.items.map((it) => (it.id === ev.item.id ? { ...ev.item } : it))
        break
      case 'clear':
        next.items = []
        break
      case 'pending':
        next.pending = ev.pending
        break
      case 'busy':
        next.busy = ev.busy
        next.running = true
        break
      case 'meta':
        if (ev.commands) next.commands = ev.commands
        if (ev.modelState) next.modelState = ev.modelState
        break
    }
    set({ chats: { ...get().chats, [p.id]: next } })
  },
  setDraft: (id, text) => set({ drafts: { ...get().drafts, [id]: text } }),
  setAttachments: (id, atts) => set({ attachments: { ...get().attachments, [id]: atts } }),
  pushInputHistory: (text) => {
    const h = [...get().inputHistory.filter((x) => x !== text), text].slice(-MAX_HISTORY)
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(h))
    } catch {
      /* quota */
    }
    set({ inputHistory: h })
  }
}))
