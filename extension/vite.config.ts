import { defineConfig } from 'vite'
import { resolve } from 'path'
import { copyFileSync, mkdirSync } from 'fs'

const root = resolve(__dirname)
const repoRoot = resolve(root, '..')

export default defineConfig({
  resolve: {
    alias: {
      '@bro/shared': resolve(repoRoot, 'packages/shared/src/index.ts'),
    },
  },
  build: {
    outDir: resolve(root, 'dist'),
    emptyOutDir: true,
    minify: false,
    rollupOptions: {
      input: {
        'service-worker': resolve(root, 'src/background/service-worker.ts'),
        'content/accessibility-tree': resolve(
          root,
          'src/content/accessibility-tree.ts',
        ),
        'content/visual-indicator': resolve(
          root,
          'src/content/visual-indicator.ts',
        ),
        options: resolve(root, 'src/options/options.ts'),
      },
      output: {
        // Each entry becomes its own file with no hash
        entryFileNames: '[name].js',
        // Avoid splitting chunks — each entry must be self-contained
        chunkFileNames: 'chunks/[name]-[hash].js',
        assetFileNames: '[name][extname]',
        // Use ES module format for the service worker (required by MV3)
        format: 'es',
        // Prevent Rollup from creating shared chunks across entry points
        // so each content script / service worker is self-contained
        manualChunks: undefined,
      },
    },
  },
  plugins: [
    {
      // Copy static assets (manifest, icons) from public/ and root to dist/
      name: 'copy-extension-assets',
      closeBundle() {
        const dist = resolve(root, 'dist')
        mkdirSync(dist, { recursive: true })

        // Copy manifest.json
        copyFileSync(resolve(root, 'manifest.json'), resolve(dist, 'manifest.json'))

        // Copy options.html
        copyFileSync(
          resolve(root, 'public/options.html'),
          resolve(dist, 'options.html'),
        )

        // Copy icon
        copyFileSync(
          resolve(root, 'public/icon128.png'),
          resolve(dist, 'icon128.png'),
        )
      },
    },
  ],
})
