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


const SOURCE_DIR = path.join('dist', 'firefox');

// 产物名跟面板标题栏上的版本号一致：版本从构建好的清单里取（2.0.0 → v2.0），
// 这样发版只要改 manifest/manifest.json 的 version，产物名自动跟上
const ARTIFACT_LABEL = `v${JSON.parse(readFileSync(path.join(SOURCE_DIR, 'manifest.json'), 'utf8')).version.split('.').slice(0, 2).join('.')}`;
const OUT_DIR = 'dist';

if (!existsSync(path.join(SOURCE_DIR, 'manifest.json'))) {
  throw new Error(`✗ ${SOURCE_DIR} 里没有产物，先跑 npm run build:firefox`);
}

const manifest = JSON.parse(readFileSync(path.join(SOURCE_DIR, 'manifest.json'), 'utf8'));

// 内置编译器的大资源必须真的进了包：少了它们插件就没有本地编译器（曾经打包时漏下，
// 结果发出去的包只有 0.6MB，用户装上才发现编译不了）
const ENGINE_ASSETS = ['engine/clang22-noeh', 'engine/lld22-noeh', 'engine/sysroot22.tar'];
const MIN_ENGINE_SIZE = 5 * 1024 * 1024;
for (const asset of ENGINE_ASSETS) {
  const file = path.join(SOURCE_DIR, asset);
  const size = existsSync(file) ? statSync(file).size : 0;
  if (size < MIN_ENGINE_SIZE) {
    throw new Error(`✗ ${asset} 没进包（${(size / 1024 / 1024).toFixed(1)} MB）：先跑 npm run fetch-engine`);
  }
}

const outFile = path.join(OUT_DIR, `pta-assistant-${ARTIFACT_LABEL}.xpi`);
mkdirSync(OUT_DIR, { recursive: true });
const count = zipDirectory(SOURCE_DIR, outFile);

console.log(`✓ ${outFile}（${(statSync(outFile).size / 1024 / 1024).toFixed(1)} MB，${count} 个文件）`);
console.log(`  清单版本 ${manifest.version}，Firefox ID ${manifest.browser_specific_settings?.gecko?.id ?? '（无）'}`);
console.log('  安装：about:debugging → 本机 → 临时载入附加组件；或把文件丢进 profile 的 extensions 目录');
