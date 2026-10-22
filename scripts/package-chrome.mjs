// 把 dist/chrome 打成 zip：上传 Chrome 应用商店要用它，也是给不方便自己 build 的人一份现成的。
// 用法：npm run package:chrome（会先构建），或 node scripts/package-chrome.mjs
//
// 注意 Chrome 不允许直接「加载压缩包」：装这个 zip 要先解压，再在
// chrome://extensions 开发者模式里「加载已解压的扩展程序」选中那个文件夹。
// 想让用户一键安装，只能传到 Chrome Web Store（需要自己的开发者账号与 5 美元注册费）。
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { zipDirectory } from './zip.mjs';


const SOURCE_DIR = path.join('dist', 'chrome');

// 产物名跟面板标题栏上的版本号一致：版本从构建好的清单里取（2.0.0 → v2.0），
// 这样发版只要改 manifest/manifest.json 的 version，产物名自动跟上
const ARTIFACT_LABEL = `v${JSON.parse(readFileSync(path.join(SOURCE_DIR, 'manifest.json'), 'utf8')).version.split('.').slice(0, 2).join('.')}`;
const OUT_DIR = 'dist';

if (!existsSync(path.join(SOURCE_DIR, 'manifest.json'))) {
  throw new Error(`✗ ${SOURCE_DIR} 里没有产物，先跑 npm run build:chrome`);
}

const manifest = JSON.parse(readFileSync(path.join(SOURCE_DIR, 'manifest.json'), 'utf8'));
const outFile = path.join(OUT_DIR, `pta-assistant-${ARTIFACT_LABEL}.zip`);
mkdirSync(OUT_DIR, { recursive: true });
// 商店审核要求：zip 根目录就是 manifest.json，不能套一层文件夹
const count = zipDirectory(SOURCE_DIR, outFile);

console.log(`✓ ${outFile}（${(statSync(outFile).size / 1024 / 1024).toFixed(1)} MB，${count} 个文件）`);
console.log(`  清单版本 ${manifest.version}，后台 ${manifest.background?.service_worker ?? '（无 service worker）'}`);
console.log('  安装：先解压，再在 chrome://extensions 开发者模式里「加载已解压的扩展程序」选解压出来的文件夹');
