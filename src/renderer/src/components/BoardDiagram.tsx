import React from 'react'
import type { Scene, SceneItem } from '@shared/types'

/**
 * Renders a declarative Scene as an SVG board snippet. KiCad-like colours:
 * F.Cu red, B.Cu blue, pads gold, zones hatched. Items flagged `bad` get a
 * magenta dashed halo; `mark` draws a red circle with an optional label.
 */
const COLORS = {
  F: 'oklch(0.66 0.19 25)',
  B: 'oklch(0.66 0.16 250)',
  pad: 'oklch(0.8 0.13 85)',
  padTh: 'oklch(0.72 0.12 85)',
  zone: 'oklch(0.6 0.12 150)',
  board: 'oklch(0.32 0.03 150)',
  part: 'oklch(0.3 0.005 255)',
  partStroke: 'oklch(0.55 0.005 255)',
  text: 'oklch(0.9 0.004 255)',
  dim: 'oklch(0.85 0.1 85)',
  bad: 'oklch(0.7 0.25 340)',
  good: 'oklch(0.74 0.13 152)',
  keepout: 'oklch(0.7 0.2 20)'
}

export function BoardDiagram({ scene, id }: { scene: Scene; id: string }): JSX.Element {
  const pad = 1
  const vb = `${-pad} ${-pad} ${scene.w + 2 * pad} ${scene.h + 2 * pad}`
  const hatch = `hatch-${id}`
  return (
    <figure className={`diagram ${scene.verdict}`}>
      <svg viewBox={vb} role="img" aria-label={scene.caption} preserveAspectRatio="xMidYMid meet">
        <defs>
          <pattern id={hatch} patternUnits="userSpaceOnUse" width="1.2" height="1.2" patternTransform="rotate(45)">
            <line x1="0" y1="0" x2="0" y2="1.2" stroke={COLORS.zone} strokeWidth="0.35" />
          </pattern>
          <marker id={`arrow-${id}`} viewBox="0 0 6 6" refX="5" refY="3" markerWidth="4" markerHeight="4" orient="auto-start-reverse">
            <path d="M0,0 L6,3 L0,6 z" fill={COLORS.dim} />
          </marker>
        </defs>
        {scene.items.map((it, i) => (
          <Item key={i} it={it} hatch={hatch} arrow={`arrow-${id}`} />
        ))}
      </svg>
      <figcaption>
        <span className={`verdict ${scene.verdict}`}>{scene.verdict === 'bad' ? 'Погано' : 'Добре'}</span>
        {scene.caption}
      </figcaption>
    </figure>
  )
}

function Item({ it, hatch, arrow }: { it: SceneItem; hatch: string; arrow: string }): JSX.Element | null {
  switch (it.t) {
    case 'board':
      return <rect x={it.x} y={it.y} width={it.w} height={it.h} fill={COLORS.board} stroke="oklch(0.85 0.1 85)" strokeWidth="0.12" rx="0.3" />
    case 'zone':
      return (
        <g>
          <rect x={it.x} y={it.y} width={it.w} height={it.h} fill={`url(#${hatch})`} stroke={COLORS.zone} strokeWidth="0.1" opacity={it.layer === 'B' ? 0.75 : 0.9} />
          {it.net && <text x={it.x + 0.4} y={it.y + it.h - 0.4} fontSize="1.1" fill={COLORS.zone}>{it.net} {it.layer}.Cu</text>}
        </g>
      )
    case 'keepout':
      return (
        <g>
          <rect x={it.x} y={it.y} width={it.w} height={it.h} fill="none" stroke={COLORS.keepout} strokeWidth="0.15" strokeDasharray="0.5 0.3" />
          {it.label && <text x={it.x + it.w / 2} y={it.y + it.h / 2} fontSize="1" fill={COLORS.keepout} textAnchor="middle">{it.label}</text>}
        </g>
      )
    case 'part': {
      const fill = it.kind === 'ic' ? COLORS.part : it.kind === 'cap' ? 'oklch(0.55 0.08 60)' : it.kind === 'xtal' ? 'oklch(0.6 0.02 255)' : COLORS.part
      return (
        <g>
          <rect x={it.x} y={it.y} width={it.w} height={it.h} fill={fill} stroke={COLORS.partStroke} strokeWidth="0.12" rx="0.2" />
          <text x={it.x + it.w / 2} y={it.y + it.h / 2 + 0.4} fontSize={Math.min(1.2, it.h * 0.5)} fill={COLORS.text} textAnchor="middle">{it.label}</text>
        </g>
      )
    }
    case 'pad':
      return (
        <g>
          <rect x={it.x - it.w / 2} y={it.y - it.h / 2} width={it.w} height={it.h} fill={it.th ? COLORS.padTh : COLORS.pad} rx={it.th ? it.w / 2 : 0.1} />
          {it.th && <circle cx={it.x} cy={it.y} r={Math.min(it.w, it.h) * 0.25} fill={COLORS.board} />}
          {it.label && <text x={it.x} y={it.y - it.h / 2 - 0.25} fontSize="0.8" fill={COLORS.text} textAnchor="middle">{it.label}</text>}
        </g>
      )
    case 'track': {
      const d = it.pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p[0]},${p[1]}`).join(' ')
      return (
        <g>
          {it.bad && <path d={d} fill="none" stroke={COLORS.bad} strokeWidth={it.w + 0.5} strokeLinecap="round" strokeLinejoin="round" strokeDasharray="0.6 0.4" opacity="0.8" />}
          <path d={d} fill="none" stroke={COLORS[it.layer]} strokeWidth={it.w} strokeLinecap="round" strokeLinejoin="round" opacity={it.layer === 'B' ? 0.85 : 1} />
        </g>
      )
    }
    case 'via': {
      const d = it.d ?? 0.6
      return (
        <g>
          {it.bad && <circle cx={it.x} cy={it.y} r={d / 2 + 0.35} fill="none" stroke={COLORS.bad} strokeWidth="0.15" strokeDasharray="0.4 0.3" />}
          <circle cx={it.x} cy={it.y} r={d / 2} fill="oklch(0.75 0.05 85)" stroke="oklch(0.5 0.05 85)" strokeWidth="0.08" />
          <circle cx={it.x} cy={it.y} r={d / 4} fill={COLORS.board} />
        </g>
      )
    }
    case 'label':
      return (
        <text x={it.x} y={it.y} fontSize={it.size ?? 1} fill={COLORS.text} textAnchor={it.anchor ?? 'start'}>
          {it.text}
        </text>
      )
    case 'dim': {
      const mx = (it.x1 + it.x2) / 2
      const my = (it.y1 + it.y2) / 2
      return (
        <g>
          <line x1={it.x1} y1={it.y1} x2={it.x2} y2={it.y2} stroke={COLORS.dim} strokeWidth="0.08" markerStart={`url(#${arrow})`} markerEnd={`url(#${arrow})`} />
          <text x={mx} y={my - 0.3} fontSize="0.85" fill={COLORS.dim} textAnchor="middle">{it.text}</text>
        </g>
      )
    }
    case 'arrow':
      return (
        <g>
          <line x1={it.x1} y1={it.y1} x2={it.x2} y2={it.y2} stroke={COLORS.dim} strokeWidth="0.1" markerEnd={`url(#${arrow})`} />
          {it.text && <text x={it.x1} y={it.y1 - 0.3} fontSize="0.85" fill={COLORS.dim}>{it.text}</text>}
        </g>
      )
    case 'mark':
      return (
        <g>
          <circle cx={it.x} cy={it.y} r={it.r ?? 1.2} fill="none" stroke={COLORS.bad} strokeWidth="0.18" />
          {it.text && <text x={it.x + (it.r ?? 1.2) + 0.3} y={it.y + 0.3} fontSize="0.9" fill={COLORS.bad}>{it.text}</text>}
        </g>
      )
    default:
      return null
  }
}
