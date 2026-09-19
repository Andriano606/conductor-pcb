import { describe, expect, it } from 'vitest'
import { navigationVerdict } from '../../src/main/navigation'

const PROD = 'file:///tmp/.mount_Conduc1/resources/app.asar/out/renderer/index.html'
const DEV = 'http://localhost:5173/'

describe('navigation of the main window', () => {
  it('a web link clicked in a chat message goes to the system browser, never into the app window', () => {
    expect(navigationVerdict('https://gltf-viewer.donmccurdy.com/', PROD)).toBe('external')
    expect(navigationVerdict('http://example.com/a?b=1', PROD)).toBe('external')
    expect(navigationVerdict('mailto:a@b.c', PROD)).toBe('external')
    expect(navigationVerdict('https://gltf-viewer.donmccurdy.com/', DEV)).toBe('external')
  })
  it('the app may reload its own page (packaged file, dev server origin)', () => {
    expect(navigationVerdict(PROD, PROD)).toBe('allow')
    expect(navigationVerdict(`${PROD}#x`, PROD)).toBe('allow')
    expect(navigationVerdict('http://localhost:5173/index.html', DEV)).toBe('allow')
  })
  it('anything else is blocked: local files from a markdown link, odd schemes, garbage', () => {
    expect(navigationVerdict('file:///home/u/board/pcb_report.md', PROD)).toBe('block')
    expect(navigationVerdict('file:///etc/passwd', DEV)).toBe('block')
    expect(navigationVerdict('javascript:alert(1)', PROD)).toBe('block')
    expect(navigationVerdict('not a url', PROD)).toBe('block')
    expect(navigationVerdict('https://x.y', '')).toBe('block')
  })
})
