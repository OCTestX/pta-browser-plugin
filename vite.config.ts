import { readFileSync } from 'node:fs';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

type BrowserTarget = 'chrome' | 'firefox';

const target: BrowserTarget = process.env.TARGET === 'firefox' ? 'firefox' : 'chrome';
// 扩展要求每个脚本都是自包含的单文件，所以一次只打一个入口
const entry = process.env.ENTRY === 'background' ? 'background' : 'content';

const ENTRY_FILES: Record<string, string> = {
  background: 'src/background/index.ts',
  content: 'src/content/index.tsx',
};

// manifest/manifest.json 是手写的基础清单（Chrome 用），Firefox 的差异在这里补
function applyFirefoxPatch(manifest: Record<string, unknown>): Record<string, unknown> {
  return {
    ...manifest,
    // Firefox 的 MV3 用非持久化的 event page，而不是 service worker
    background: { scripts: ['background.js'] },
    browser_specific_settings: {
      gecko: { id: 'pta-assistant@example.com', strict_min_version: '115.0' },
    },
  };
}

function manifestPlugin(): Plugin {
  return {
    name: 'pta-manifest',
    generateBundle() {
      const base = JSON.parse(
        readFileSync(new URL('./manifest/manifest.json', import.meta.url), 'utf8'),
      ) as Record<string, unknown>;
      const manifest = target === 'firefox' ? applyFirefoxPatch(base) : base;
      this.emitFile({
        type: 'asset',
        fileName: 'manifest.json',
        source: `${JSON.stringify(manifest, null, 2)}\n`,
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), manifestPlugin()],
  build: {
    outDir: `dist/${target}`,
    // 每个入口单独一次构建，第二次构建不能清掉第一次的产物
    emptyOutDir: false,
    target: 'esnext',
    rollupOptions: {
      input: ENTRY_FILES[entry],
      output: {
        format: 'iife',
        entryFileNames: `${entry}.js`,
        assetFileNames: '[name][extname]',
      },
    },
  },
});
