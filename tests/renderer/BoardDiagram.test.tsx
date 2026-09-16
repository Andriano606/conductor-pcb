// @vitest-environment jsdom
import React from 'react'
import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { BoardDiagram } from '../../src/renderer/src/components/BoardDiagram'
import type { Scene } from '@shared/types'

const scene: Scene = {
  w: 20,
  h: 10,
  verdict: 'bad',
  caption: 'підпис',
  items: [
    { t: 'board', x: 0, y: 0, w: 20, h: 10 },
    { t: 'zone', x: 1, y: 1, w: 18, h: 8, layer: 'B', net: 'GND' },
    { t: 'track', pts: [[2, 5], [10, 5], [12, 7]], w: 0.3, layer: 'F', bad: true },
    { t: 'via', x: 12, y: 7, bad: true },
    { t: 'pad', x: 5, y: 5, w: 1, h: 1, th: true, label: 'P' },
    { t: 'mark', x: 12, y: 7, text: 'тут' },
    { t: 'dim', x1: 2, y1: 8, x2: 10, y2: 8, text: '8 мм' },
    { t: 'part', x: 14, y: 2, w: 4, h: 3, label: 'U1', kind: 'ic' }
  ]
}

describe('BoardDiagram', () => {
  it('renders every item type into the svg and shows the verdict', () => {
    const { container, getByText } = render(<BoardDiagram scene={scene} id="t" />)
    const svg = container.querySelector('svg')!
    expect(svg.getAttribute('viewBox')).toBe('-1 -1 22 12')
    expect(svg.querySelectorAll('path').length).toBeGreaterThanOrEqual(2) // bad halo + track
    expect(svg.querySelectorAll('circle').length).toBeGreaterThanOrEqual(3)
    expect(getByText('Погано')).toBeInTheDocument()
    expect(getByText('підпис')).toBeInTheDocument()
    expect(getByText('8 мм')).toBeInTheDocument()
    expect(getByText('U1')).toBeInTheDocument()
  })
})
