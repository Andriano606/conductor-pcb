import React, { useEffect, useRef, useState } from 'react'
import type { PcbProject } from '@shared/types'
import { sessionLabel } from '@shared/projects'
import { useStore } from '../store'
import { useChatStore } from '../chatStore'

/**
 * The strip of Claude session tabs for a project, shown in the composer toolbar.
 * Switch between sessions, add a new one (+), close any non-last session (×),
 * and double-click or right-click a tab to rename it. The busy spinner lights
 * per session. Ported from conductor-linux.
 */
export function SessionTabs({ project, activeSessionId }: { project: PcbProject; activeSessionId: string }): JSX.Element {
  const setActiveSession = useStore((s) => s.setActiveSession)
  const chats = useChatStore((s) => s.chats)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editText, setEditText] = useState('')
  const editRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (editingId) editRef.current?.select()
  }, [editingId])

  const canClose = project.sessions.length > 1

  const addSession = async (): Promise<void> => {
    const session = await window.api.createSession(project.id)
    if (session) setActiveSession(project.id, session.id)
  }

  const closeSession = async (sessionId: string): Promise<void> => {
    if (sessionId === activeSessionId) {
      const i = project.sessions.findIndex((s) => s.id === sessionId)
      const sibling = project.sessions[i + 1] ?? project.sessions[i - 1]
      if (sibling) setActiveSession(project.id, sibling.id)
    }
    await window.api.closeSession(sessionId)
    useChatStore.getState().dispose(sessionId)
  }

  const startRename = (sessionId: string): void => {
    setEditingId(sessionId)
    setEditText(sessionLabel(project, sessionId))
  }

  const commitRename = (): void => {
    if (editingId) void window.api.renameSession(editingId, editText.trim())
    setEditingId(null)
  }

  return (
    <div className="session-tabs">
      {project.sessions.map((s) => (
        <div
          key={s.id}
          className={`session-tab ${s.id === activeSessionId ? 'active' : ''}`}
          onClick={() => setActiveSession(project.id, s.id)}
          onDoubleClick={() => startRename(s.id)}
          onContextMenu={(e) => {
            e.preventDefault()
            startRename(s.id)
          }}
          title="Подвійний клік або права кнопка — перейменувати"
        >
          {editingId === s.id ? (
            <input
              ref={editRef}
              className="session-tab-edit"
              value={editText}
              autoFocus
              onChange={(e) => setEditText(e.target.value)}
              onClick={(e) => e.stopPropagation()}
              onBlur={commitRename}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitRename()
                else if (e.key === 'Escape') {
                  e.preventDefault()
                  setEditingId(null)
                }
              }}
            />
          ) : (
            <>
              {chats[s.id]?.busy && <span className="session-tab-spin" />}
              <span className="session-tab-name">{sessionLabel(project, s.id)}</span>
              {canClose && (
                <button
                  className="session-tab-close"
                  title="Закрити сесію"
                  onClick={(e) => {
                    e.stopPropagation()
                    void closeSession(s.id)
                  }}
                >
                  ×
                </button>
              )}
            </>
          )}
        </div>
      ))}
      <button className="session-tab-add" title="Нова сесія Claude" onClick={() => void addSession()}>
        +
      </button>
    </div>
  )
}
