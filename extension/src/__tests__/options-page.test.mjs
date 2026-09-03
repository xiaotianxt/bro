import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

describe('options page', () => {
  it('loads the imported options script as an ES module', () => {
    const html = readFileSync(
      new URL('../../public/options.html', import.meta.url),
      'utf8',
    )
    const script = readFileSync(
      new URL('../options/options.ts', import.meta.url),
      'utf8',
    )

    expect(script).toMatch(/^import /m)
    expect(html).toContain('<script type="module" src="options.js"></script>')
    expect(html).toContain('<details id="connection-settings" class="connection-settings">')
    for (const id of [
      'userscript-list',
      'userscript-form',
      'script-description',
      'script-matches',
      'script-code',
    ]) {
      expect(html).toContain(`id="${id}"`)
    }
  })
})
