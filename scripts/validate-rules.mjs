#!/usr/bin/env node
// Structural validation of every rules/*.json (plus any extra dirs passed as args).
// The full validation (same code as the app) runs in `npm test` (tests/shared/rules-files.test.ts).
import { readdirSync, readFileSync } from 'fs'
import { join, resolve } from 'path'
import { fileURLToPath } from 'url'

const here = fileURLToPath(new URL('.', import.meta.url))
const dirs = [resolve(here, '../rules'), ...process.argv.slice(2)]
const REQUIRED = ['code', 'title', 'category', 'severity', 'summary', 'description', 'why', 'fix', 'params', 'checker', 'tags', 'references', 'examples', 'enabled']
let failed = 0
const codes = new Set()
for (const dir of dirs) {
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.json')).sort()) {
    const file = join(dir, f)
    try {
      const r = JSON.parse(readFileSync(file, 'utf8'))
      const p = REQUIRED.filter((k) => !(k in r)).map((k) => `missing ${k}`)
      if (r.code && !/^[A-Z][A-Z0-9_]{2,63}$/.test(r.code)) p.push('bad code')
      if (codes.has(r.code)) p.push(`duplicate code ${r.code}`)
      codes.add(r.code)
      for (const k of ['bad', 'good']) {
        const s = r.examples?.[k]
        if (!s || !Array.isArray(s.items) || s.verdict !== k) p.push(`examples.${k} invalid`)
      }
      if (p.length) { failed++; console.log(`✗ ${f}\n   ${p.join('\n   ')}`) } else console.log(`✓ ${f}`)
    } catch (e) { failed++; console.log(`✗ ${file}: ${e.message}`) }
  }
}
console.log(failed ? `\n${failed} file(s) with problems` : `\n${codes.size} rules valid`)
process.exit(failed ? 1 : 0)
