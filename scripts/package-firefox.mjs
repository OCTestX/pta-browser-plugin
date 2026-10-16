// 把 dist/firefox 打成可安装的 xpi。
// 用法：npm run package:firefox（会先构建），或 node scripts/package-firefox.mjs
//
// 为什么要自己打而不用 web-ext：
//   1) 文件名要跟面板上显示的版本一致（Chrome 的清单版本号必须是数字，带不了 alpha 后缀，
//      所以面板徽标是 v1.0-beta、清单还是 1.0.0，产物名取前者更不容易装错版本）；
//   2) 不签名也能装（about:debugging → 临时载入，或丢进 profile 的 extensions 目录），
//      产物里只有 dist/firefox 的内容，没有 web-ext 的临时文件。
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { deflateRawSync } from 'node:zlib';

// 面板标题栏上显示的版本；manifest 的 version 只能填数字，这个标签只进文件名
const ARTIFACT_LABEL = 'v1.0-beta';
const SOURCE_DIR = path.join('dist', 'firefox');
const OUT_DIR = 'dist';

function collect(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...collect(full));
    else files.push(full);
  }
  return files.sort();
}

/** 手写 zip：deflate 原始数据 + CRC32，不依赖任何外部包 */
function zip(files) {
  const local = [];
  const central = [];
  let offset = 0;

  for (const file of files) {
    const name = Buffer.from(path.relative(SOURCE_DIR, file).split(path.sep).join('/'), 'utf8');
    const raw = readFileSync(file);
    const crc = crc32(raw);
    const deflated = deflateRawSync(raw, { level: 9 });
    // 压不小就存原始数据（小文件上 deflate 反而变大）
    const useDeflate = deflated.length < raw.length;
    const data = useDeflate ? deflated : raw;
    const method = useDeflate ? 8 : 0;

    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4); // version needed
    header.writeUInt16LE(0, 6); // flags
    header.writeUInt16LE(method, 8);
    header.writeUInt16LE(0, 10); // time
    header.writeUInt16LE(0x21, 12); // date（2000-01-01，固定值保证可复现）
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(data.length, 18);
    header.writeUInt32LE(raw.length, 22);
    header.writeUInt16LE(name.length, 26);
    header.writeUInt16LE(0, 28);
    local.push(header, name, data);

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4); // version made by
    entry.writeUInt16LE(20, 6); // version needed
    entry.writeUInt16LE(0, 8); // flags
    entry.writeUInt16LE(method, 10);
    entry.writeUInt16LE(0, 12);
    entry.writeUInt16LE(0x21, 14);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(data.length, 20);
    entry.writeUInt32LE(raw.length, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, name);

    offset += header.length + name.length + data.length;
  }

  const centralBuffer = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, centralBuffer, end]);
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

if (!existsSync(path.join(SOURCE_DIR, 'manifest.json'))) {
  throw new Error(`✗ ${SOURCE_DIR} 里没有产物，先跑 npm run build:firefox`);
}

const manifest = JSON.parse(readFileSync(path.join(SOURCE_DIR, 'manifest.json'), 'utf8'));
const files = collect(SOURCE_DIR);
const outFile = path.join(OUT_DIR, `pta-assistant-${ARTIFACT_LABEL}.xpi`);
mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(outFile, zip(files));

const mb = (statSync(outFile).size / 1024 / 1024).toFixed(1);
console.log(`✓ ${outFile}（${mb} MB，${files.length} 个文件）`);
console.log(`  清单版本 ${manifest.version}，Firefox ID ${manifest.browser_specific_settings?.gecko?.id ?? '（无）'}`);
console.log('  安装：about:debugging → 本机 → 临时载入附加组件；或把文件丢进 profile 的 extensions 目录');
