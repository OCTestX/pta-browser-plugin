// 下载内置 Python 运行时（Pyodide）的资源（约 12MB，只需一次）。
// 之后 Python 代码在插件内部跑，不联网、代码不出本机。
//
// 用法：node scripts/fetch-pyodide.mjs [--force]
//
// 来源：Pyodide v0.26.4（MIT / PSF-2.0 双许可，详见 https://github.com/pyodide/pyodide）
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, stat, unlink } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';

const OUT_DIR = 'public/engine/pyodide';
const BASE_URL = 'https://cdn.jsdelivr.net/pyodide/v0.26.4/full';

const ASSETS = [
  { name: 'pyodide.mjs', size: 13779, sha256: '7f24c6655a79eacf0061d3d4e6a60dc0b1938812d15c52d7ff8b37d9e0689e51' },
  { name: 'pyodide.asm.wasm', size: 10088051, sha256: 'b7e66a19427a55010ac3367c1b6c64b893f9826f783412945fdf0c3337f3bc94' },
  { name: 'python_stdlib.zip', size: 2341872, sha256: '72894522b791858b9d613ac786b951d8b5094035dcf376313ea24a466810f336' },
  // asm.js 是 wasm 的 JS 胶水层，lock 文件是包索引：少了这两个 Pyodide 起不来
  { name: 'pyodide.asm.js', size: 1229099, sha256: '' },
  { name: 'pyodide-lock.json', size: 106335, sha256: '' },
];

const force = process.argv.includes('--force');

async function fileSize(file) {
  try {
    return (await stat(file)).size;
  } catch {
    return -1;
  }
}

async function download({ name, size, sha256 }, attempts = 3) {
  const target = path.join(OUT_DIR, name);
  const response = await fetch(`${BASE_URL}/${name}`);
  if (!response.ok || !response.body) {
    throw new Error(`HTTP ${response.status}`);
  }

  const temp = `${target}.part`;
  await pipeline(Readable.fromWeb(response.body), createWriteStream(temp));
  const got = await fileSize(temp);
  if (got !== size) throw new Error(`大小不对（期望 ${size}，实际 ${got}）`);

  if (sha256) {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(temp)) hash.update(chunk);
    if (hash.digest('hex') !== sha256) throw new Error('sha256 对不上，文件不完整');
  }

  await rename(temp, target);
  console.log(`✓ ${name} ${(size / 1048576).toFixed(1)}MB 已下载校验通过`);
}

async function ensureAsset(asset) {
  const target = path.join(OUT_DIR, asset.name);
  const currentSize = await fileSize(target);
  if (!force && currentSize === asset.size) {
    console.log(`✓ ${asset.name} 已就位（${(currentSize / 1048576).toFixed(1)}MB）`);
    return;
  }
  if (currentSize >= 0) {
    await unlink(target);
    console.log(`· ${asset.name} 不完整（${currentSize} 字节），重新下载`);
  }
  console.log(`· 正在下载 ${asset.name}（约 ${(asset.size / 1048576).toFixed(1)}MB）`);
  await download(asset);
}

await mkdir(OUT_DIR, { recursive: true });
await Promise.all(ASSETS.map((asset) => ensureAsset(asset).catch((error) => {
  throw new Error(`✗ ${asset.name} 下载失败：${error.message}\n  离线环境请手动从 ${BASE_URL} 下载后放进 ${OUT_DIR}/`);
})));

console.log('\n内置 Python 运行时资源就绪（运行时不联网）');
