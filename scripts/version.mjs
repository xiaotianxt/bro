// bro's version lives in cmd/bro/main.go; every other copy must match it.
//
//   node scripts/version.mjs            check that all copies match
//   node scripts/version.mjs 2.0.0      set every copy to 2.0.0
import fs from 'node:fs'

const root = new URL('../', import.meta.url)
const semver = '[0-9]+\\.[0-9]+\\.[0-9]+'
const copies = [
  { file: 'cmd/bro/main.go', pattern: `const version = "(${semver})"` },
  { file: 'extension/manifest.json', pattern: `"version": "(${semver})"` },
  { file: 'package.json', pattern: `"version": "(${semver})"` },
  { file: 'extension/package.json', pattern: `"version": "(${semver})"` },
  { file: 'packages/shared/package.json', pattern: `"version": "(${semver})"` },
  { file: 'pi-extension/package.json', pattern: `"version": "(${semver})"` },
  { file: 'README.md', pattern: `git:github.com/xiaotianxt/bro@v(${semver})` },
  { file: 'pi-extension/README.md', pattern: `git:github.com/xiaotianxt/bro@v(${semver})` },
]

function read(file) {
  return fs.readFileSync(new URL(file, root), 'utf8')
}

// Each copy must occur exactly once, so a replacement cannot hit the wrong line.
function find({ file, pattern }) {
  const matches = [...read(file).matchAll(new RegExp(pattern, 'g'))]
  if (matches.length !== 1) throw new Error(`${file}: expected one match of ${pattern}, found ${matches.length}`)
  return matches[0]
}

const target = process.argv[2]
if (target === undefined) {
  const versions = copies.map((copy) => [copy.file, find(copy)[1]])
  const expected = versions[0][1]
  const wrong = versions.filter(([, version]) => version !== expected)
  if (wrong.length) {
    console.error(`version mismatch with cmd/bro/main.go (${expected}): ${wrong.map(([file, version]) => `${file}=${version}`).join(' ')}`)
    process.exit(1)
  }
  console.log(expected)
} else {
  if (!new RegExp(`^${semver}$`).test(target)) throw new Error(`version must be x.y.z, got ${target}`)
  for (const copy of copies) {
    const match = find(copy)
    const text = read(copy.file)
    const replaced = match[0].replace(match[1], target)
    fs.writeFileSync(new URL(copy.file, root), text.slice(0, match.index) + replaced + text.slice(match.index + match[0].length))
  }
  console.log(target)
}
