/**
 * The app is a single page and has no built-in browser. A plain `<a href>` (every markdown link in a chat
 * message or a rule text) would otherwise navigate the main window itself and replace the whole app with the
 * site; `setWindowOpenHandler` only covers `target=_blank` / `window.open`. So every navigation away from the
 * app's own page is cancelled, and web links go to the system browser instead.
 */
export type NavigationVerdict = 'allow' | 'external' | 'block'

const EXTERNAL_PROTOCOLS = ['http:', 'https:', 'mailto:']

/** What to do with a navigation of the main window to `url` while the app itself is loaded from `appUrl`. */
export function navigationVerdict(url: string, appUrl: string): NavigationVerdict {
  let target: URL
  let own: URL
  try {
    target = new URL(url)
    own = new URL(appUrl)
  } catch {
    return 'block'
  }
  // the app's own page: a reload, or the dev server (same origin) doing a full HMR reload
  if (own.protocol === 'file:' ? target.protocol === 'file:' && target.pathname === own.pathname : target.origin === own.origin) return 'allow'
  return EXTERNAL_PROTOCOLS.includes(target.protocol) ? 'external' : 'block'
}
