// 下载内置 C 编译器的三大资源（约 91MB，只需一次）。
// 之后编译、运行全在本地，不再需要网络；三个大文件不进 git，这里按 sha256 校验一份。
// 来源：cppstudio-io/wasm-clang-runtime v0.1.0（Apache-2.0）
//   clang22-noeh / lld22-noeh：Clang 22.1.8 + LLD 编译成的 wasm（剥掉 exnref 指令的兼容版）
//   sysroot22.tar：wasi-sdk 33 的 sysroot（C 头文件 + libc.a）
// memfs 不在上游 Release 里，已按上游 src/memfs/build.sh 用 wasi-sdk 33 重新编译，随仓库走。
//
// 用法：node scripts/fetch-engine.mjs [--force]
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, stat, unlink } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';

const OUT_DIR = 'public/engine';
const BASE_URL = 'https://github.com/cppstudio-io/wasm-clang-runtime/releases/download/v0.1.0';

const ASSETS = [
  { name: 'clang22-noeh', size: 36100574, sha256: 'e01346e33b31a3b3359a317450502bd4feb78cd6ca7fed08aca8601f9ff8834d' },
  { name: 'lld22-noeh', size: 19183252, sha256: '63c397c582e193aacd96fbdeb04b1bd32f47ae505f6dc4a569ed08a80ddfeff7' },
  { name: 'sysroot22.tar', size: 39876608, sha256: 'd991c621cdf9b4640c2cd4aa21abb08491c2ae6ef9917cac5c6065553604bcec' },
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

  // 半个文件会污染下一次加载，先写临时文件、校验过了才落盘
  const temp = `${target}.part`;
  await pipeline(Readable.fromWeb(response.body), createWriteStream(temp));
  const got = await fileSize(temp);
  if (got !== size) throw new Error(`大小不对（期望 ${size}，实际 ${got}）`);

  const hash = createHash('sha256');
  for await (const chunk of createReadStream(temp)) hash.update(chunk);
  if (hash.digest('hex') !== sha256) throw new Error('sha256 对不上，文件不完整');

  await rename(temp, target);
  console.log(`✓ ${name} ${Math.round(size / 1048576)}MB 已下载校验通过`);
}

async function ensureAsset(asset) {
  const target = path.join(OUT_DIR, asset.name);
  const currentSize = await fileSize(target);
  if (!force && currentSize === asset.size) {
    console.log(`✓ ${asset.name} 已就位（${Math.round(currentSize / 1048576)}MB）`);
    return;
  }
  if (currentSize >= 0) {
    await unlink(target);
    console.log(`· ${asset.name} 不完整（${currentSize} 字节），重新下载`);
  }
  console.log(`· 正在下载 ${asset.name}（约 ${Math.round(asset.size / 1048576)}MB）`);
  await download(asset);
}

await mkdir(OUT_DIR, { recursive: true });
await Promise.all(ASSETS.map((asset) => ensureAsset(asset).catch((error) => {
  throw new Error(`✗ ${asset.name} 下载失败：${error.message}\n  离线环境请手动从 ${BASE_URL} 下载后放进 ${OUT_DIR}/`);
})));

// 引擎自身的 JS 与 memfs 应该在仓库里，缺了说明目录被清了
for (const name of ['shared.js', 'engine-core.js', 'compile-worker.js', 'compiler-host.js', 'compiler-host.html', 'memfs']) {
  if ((await fileSize(path.join(OUT_DIR, name))) < 0) {
    throw new Error(`✗ ${OUT_DIR}/${name} 不见了，这个文件应该在 git 里`);
  }
}

console.log('\n内置 C 编译器资源就绪（编译运行时不联网）');
