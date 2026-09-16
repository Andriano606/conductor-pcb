import React, { useEffect } from 'react'
import { useStore } from '../store'

/** In-app confirmation (native confirm() misbehaves on Linux/Wayland). */
export function ConfirmModal(): JSX.Element | null {
  const confirm = useStore((s) => s.confirm)
  const resolveConfirm = useStore((s) => s.resolveConfirm)
  useEffect(() => {
    if (!confirm) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') resolveConfirm(false)
      if (e.key === 'Enter') resolveConfirm(true)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [confirm, resolveConfirm])
  if (!confirm) return null
  return (
    <div className="modal-backdrop confirm" onMouseDown={(e) => e.target === e.currentTarget && resolveConfirm(false)}>
      <div className="modal small" role="alertdialog">
        <p className="confirm-text">{confirm.message}</p>
        <div className="modal-actions">
          <button className="btn" onClick={() => resolveConfirm(false)}>Скасувати</button>
          <button className="btn primary" autoFocus onClick={() => resolveConfirm(true)}>Так</button>
        </div>
      </div>
    </div>
  )
}
