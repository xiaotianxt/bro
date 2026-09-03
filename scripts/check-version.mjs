import fs from 'node:fs'

function readJson(path) {
  return JSON.parse(fs.readFileSync(new URL(path, import.meta.url), 'utf8'))
}

const cargo = fs.readFileSync(new URL('../Cargo.toml', import.meta.url), 'utf8')
const cargoVersion = cargo.match(/^version = "([^"]+)"$/m)?.[1]
const versions = {
  manifest: readJson('../extension/manifest.json').version,
  rootPackage: readJson('../package.json').version,
  browserPackage: readJson('../extension/package.json').version,
  sharedPackage: readJson('../packages/shared/package.json').version,
  piPackage: readJson('../pi-extension/package.json').version,
}

if (!cargoVersion || Object.values(versions).some((version) => version !== cargoVersion)) {
  console.error(
    `version mismatch: Cargo=${cargoVersion ?? 'missing'} ${Object.entries(versions)
      .map(([name, version]) => `${name}=${version}`)
      .join(' ')}`,
  )
  process.exit(1)
}
