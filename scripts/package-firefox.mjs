// 把 dist/firefox 打成可安装的 xpi。
// 用法：npm run package:firefox（会先构建），或 node scripts/package-firefox.mjs
//
// 为什么要自己打而不用 web-ext：
//   1) 文件名要跟面板上显示的版本一致（Chrome 的清单版本号必须是数字，带不了 alpha/beta 后缀，
//      所以面板徽标是 v1.0、清单还是 1.0.0，产物名取前者更不容易装错版本）；
//   2) 不签名也能装（about:debugging → 临时载入，或丢进 profile 的 extensions 目录），
//      产物里只有 dist/firefox 的内容，没有 web-ext 的临时文件。
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { zipDirectory } from './zip.mjs';

// 面板标题栏上显示的版本；manifest 的 version 只能填数字，这个标签只进文件名
const ARTIFACT_LABEL = 'v1.0';
const SOURCE_DIR = path.join('dist', 'firefox');
const OUT_DIR = 'dist';

if (!existsSync(path.join(SOURCE_DIR, 'manifest.json'))) {
  throw new Error(`✗ ${SOURCE_DIR} 里没有产物，先跑 npm run build:firefox`);
}

const manifest = JSON.parse(readFileSync(path.join(SOURCE_DIR, 'manifest.json'), 'utf8'));
const outFile = path.join(OUT_DIR, `pta-assistant-${ARTIFACT_LABEL}.xpi`);
mkdirSync(OUT_DIR, { recursive: true });
const count = zipDirectory(SOURCE_DIR, outFile);

console.log(`✓ ${outFile}（${(statSync(outFile).size / 1024 / 1024).toFixed(1)} MB，${count} 个文件）`);
console.log(`  清单版本 ${manifest.version}，Firefox ID ${manifest.browser_specific_settings?.gecko?.id ?? '（无）'}`);
console.log('  安装：about:debugging → 本机 → 临时载入附加组件；或把文件丢进 profile 的 extensions 目录');
