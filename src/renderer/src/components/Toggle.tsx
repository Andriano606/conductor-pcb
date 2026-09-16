import React from 'react'

/** iOS-style on/off switch. */
export function Toggle({ checked, onChange, label, disabled, size = 'md' }: { checked: boolean; onChange: (v: boolean) => void; label?: string; disabled?: boolean; size?: 'xs' | 'sm' | 'md' }): JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      title={label}
      disabled={disabled}
      className={'toggle' + (checked ? ' on' : '') + (size === 'sm' ? ' sm' : size === 'xs' ? ' xs' : '')}
      onClick={() => onChange(!checked)}
    >
      <span className="toggle-knob" />
    </button>
  )
}
