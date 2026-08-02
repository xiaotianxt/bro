import fs from 'node:fs'

const cargo = fs.readFileSync(new URL('../Cargo.toml', import.meta.url), 'utf8')
const manifest = JSON.parse(
  fs.readFileSync(new URL('../extension/manifest.json', import.meta.url), 'utf8'),
)
const cargoVersion = cargo.match(/^version = "([^"]+)"$/m)?.[1]

if (!cargoVersion || manifest.version !== cargoVersion) {
  console.error(`version mismatch: Cargo=${cargoVersion ?? 'missing'} extension=${manifest.version}`)
  process.exit(1)
}
