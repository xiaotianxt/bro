#!/usr/bin/env node
// Build script for @bro/shared
// Produces both ESM (.js) and CJS (.cjs) output using tsc.

import { execSync } from 'node:child_process'
import { readdirSync, readFileSync, writeFileSync, rmSync, mkdirSync, existsSync } from 'node:fs'
import { join, basename } from 'node:path'

const distDir = new URL('./dist', import.meta.url).pathname

// Step 1: Build ESM (uses tsconfig.json with NodeNext/ESM)
console.log('Building ESM...')
execSync('tsc -p tsconfig.json', { stdio: 'inherit' })

// Step 2: Build CJS to a temp directory
console.log('Building CJS...')
const tempDir = new URL('./dist-cjs-temp', import.meta.url).pathname
if (existsSync(tempDir)) {
  rmSync(tempDir, { recursive: true })
}
mkdirSync(tempDir, { recursive: true })

// Create a temp tsconfig for CJS
const cjsTsconfig = {
  compilerOptions: {
    target: 'ES2022',
    outDir: './dist-cjs-temp',
    rootDir: './src',
    module: 'CommonJS',
    moduleResolution: 'Node',
    declaration: false,
    declarationMap: false,
    sourceMap: false,
    strict: true,
    noUncheckedIndexedAccess: true,
    exactOptionalPropertyTypes: true,
  },
  include: ['src/**/*.ts'],
  exclude: ['src/**/*.test.ts', 'src/**/__tests__/**'],
}
writeFileSync(
  new URL('./tsconfig.cjs.temp.json', import.meta.url).pathname,
  JSON.stringify(cjsTsconfig, null, 2),
)

execSync('tsc -p tsconfig.cjs.temp.json', { stdio: 'inherit' })

// Step 3: Rename .js files to .cjs and move to dist/
function processDir(srcDir, dstDir) {
  mkdirSync(dstDir, { recursive: true })
  for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      processDir(join(srcDir, entry.name), join(dstDir, entry.name))
    } else if (entry.name.endsWith('.js')) {
      const newName = basename(entry.name, '.js') + '.cjs'
      const src = join(srcDir, entry.name)
      const dst = join(dstDir, newName)
      // Read, fix local require paths (.js -> .cjs), write.
      let content = readFileSync(src, 'utf8')
      content = content.replace(/require\((['"])(\.{1,2}\/[^'"]+)\.js\1\)/g, 'require($1$2.cjs$1)')
      writeFileSync(dst, content, 'utf8')
    }
  }
}

processDir(tempDir, distDir)

// Step 4: Clean up temp files
rmSync(tempDir, { recursive: true })
rmSync(new URL('./tsconfig.cjs.temp.json', import.meta.url).pathname)

console.log('Build complete.')
