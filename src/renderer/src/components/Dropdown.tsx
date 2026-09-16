import { useEffect, useRef, useState, type ReactNode } from 'react'

/** One row in a {@link Dropdown} menu. */
export interface DropdownItem {
  key: string
  label: ReactNode
  onClick: () => void
  /** Show a ✓ in the leading gutter (the currently-selected option). */
  checked?: boolean
  /**
   * Render a small trailing on/off switch reflecting `checked` instead of the
   * leading ✓ (for rows that toggle membership rather than pick one option).
   * The whole row stays the click target — the switch is purely visual.
   */
  toggle?: boolean
  /**
   * Keep the menu open after this item fires (for toggle rows, so several can
   * be flipped in one visit). The caller usually pairs this with `onClose` to
   * commit the accumulated changes when the menu finally closes.
   */
  keepOpen?: boolean
  /** Render in the danger color (destructive action). */
  danger?: boolean
  /** Draw a thin separator above this item (e.g. before a "manage…" action). */
  separatorBefore?: boolean
}

/**
 * A small click-to-open menu: a trigger button with a popover list below it.
 * Closes on outside click, Escape, or after an item fires. Used for the IDE and
 * Claude-config pickers — a button whose dropdown selects (and persists) one of
 * the configured options. `align="right"` anchors the menu to the trigger's
 * right edge (for triggers near the window edge).
 */
export function Dropdown({
  triggerClass,
  triggerTitle,
  triggerContent,
  items,
  align = 'left',
  direction = 'down',
  disabled,
  menuClass,
  onClose
}: {
  triggerClass?: string
  triggerTitle?: string
  triggerContent: ReactNode
  items: DropdownItem[]
  align?: 'left' | 'right'
  /** Open the menu below ('down', default) or above ('up') the trigger. */
  direction?: 'up' | 'down'
  disabled?: boolean
  menuClass?: string
  /** Fired on every close (outside click, Escape, trigger re-click, item click). */
  onClose?: () => void
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)
  // Ref mirror so the window listeners (registered once per open) always call
  // the freshest callback — the caller's closure changes as items are toggled.
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  const close = (): void => {
    setOpen(false)
    onCloseRef.current?.()
  }

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) close()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close()
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  return (
    <div className="dropdown" ref={wrapRef}>
      <button
        type="button"
        className={triggerClass}
        title={triggerTitle}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => (open ? close() : setOpen(true))}
      >
        {triggerContent}
      </button>
      {open && items.length > 0 && (
        <div
          className={`dropdown-menu ${align === 'right' ? 'right' : ''} ${
            direction === 'up' ? 'up' : ''
          } ${menuClass ?? ''}`}
          role="menu"
        >
          {items.map((it) => (
            <button
              key={it.key}
              type="button"
              role="menuitemradio"
              aria-checked={!!it.checked}
              className={`dropdown-item${it.checked ? ' checked' : ''}${it.danger ? ' danger' : ''}${
                it.separatorBefore ? ' sep' : ''
              }`}
              onClick={() => {
                if (!it.keepOpen) close()
                it.onClick()
              }}
            >
              <span className="dropdown-check">{!it.toggle && it.checked ? '✓' : ''}</span>
              <span className="dropdown-label">{it.label}</span>
              {it.toggle && (
                <span className={`switch switch-xs${it.checked ? ' on' : ''}`} aria-hidden="true">
                  <span className="slider" />
                </span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
