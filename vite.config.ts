import { readFileSync } from 'node:fs';
import { copyFile, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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
    // offscreen 是 Chrome 独有的：Firefox 直接在 event page 里 new Worker
    permissions: ((manifest.permissions as string[] | undefined) ?? []).filter(
      (permission) => permission !== 'offscreen',
    ),
    // Firefox 的 content_security_policy 只认字符串形式（Chrome 认 { extension_pages: ... } 对象）。
    // 两个浏览器都需要在扩展页 CSP 里放行 wasm，否则 Worker 里 WebAssembly.compile 会被拦
    content_security_policy: (manifest.content_security_policy as { extension_pages?: string } | undefined)
      ?.extension_pages,
  };
}

// Chrome 用 base::IsStringUTF8 校验内容脚本，Unicode 非字符（U+FFFE/U+FFFF 之类）会被判成
// 「不是 UTF-8 编码」而拒绝加载，但是 Python / Node 的严格解码都会放行，本地很难发现。
// 依赖里有裸的非字符（正则字符类里的 \uffff），构建产物统一转义掉。
function escapeNoncharactersPlugin(): Plugin {
  const escape = (code: string): string =>
    code.replace(/[\uFDD0-\uFDEF\uFFFE\uFFFF]/gu, (char) => {
      const hex = (char.codePointAt(0) ?? 0).toString(16).padStart(4, '0');
      return `\\u${hex}`;
    });

  return {
    name: 'pta-escape-noncharacters',
    // 必须在压缩之后：压缩器会把 \uffff 这种转义再写成字面字符
    generateBundle(_options, bundle) {
      for (const item of Object.values(bundle)) {
        if (item.type === 'chunk') {
          item.code = escape(item.code);
        } else if (item.fileName.endsWith('.js') && typeof item.source === 'string') {
          item.source = escape(item.source);
        }
      }
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

// KaTeX 的样式引用了自己的字库，必须跟着产物一起走（只带 woff2，浏览器优先用它）
function katexFontsPlugin(): Plugin {
  return {
    name: 'pta-katex-fonts',
    async writeBundle(options) {
      const outDir = options.dir ?? `dist/${target}`;
      const from = fileURLToPath(new URL('./node_modules/katex/dist/fonts', import.meta.url));
      const to = path.join(outDir, 'katex-fonts');
      await mkdir(to, { recursive: true });
      const files = await readdir(from);
      await Promise.all(
        files
          .filter((file) => file.endsWith('.woff2'))
          .map((file) => copyFile(path.join(from, file), path.join(to, file))),
      );
    },
  };
}

export default defineConfig({
  plugins: [react(), escapeNoncharactersPlugin(), manifestPlugin(), katexFontsPlugin()],
  build: {
    outDir: `dist/${target}`,
    // 每个入口单独一次构建：第一次清空目录内容（Vite 只删内容、保留目录本身，
    // 目录被删掉重建会让浏览器里已加载的插件指向不存在的路径），第二次保留第一次的产物
    emptyOutDir: entry === 'background',
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
