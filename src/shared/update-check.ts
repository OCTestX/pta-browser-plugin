// 更新检测的纯逻辑：版本号解析、比较、挑安装包。
// 这里不碰任何浏览器 API（不 import chrome 包装），这样 scripts/test-update-check.mjs
// 可以让 Node 剥掉类型后直接导入本模块做单测。
//
// 带上 .ts 后缀：Node 不做省略后缀解析；Vite 与 tsc 都认这个写法。

/** 解析出来的版本号（缺的段按 0 补） */
export interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
}

/** release 资产里的一条（只要名字与下载地址） */
export interface ReleaseAsset {
  name?: string;
  browser_download_url?: string;
}

/**
 * 解析版本号：`v6.9.0` / `6.9.0` / `v3.1` / `v2.0` 都认。
 *
 * release 标签里确实有两段的（v3.1、v2.0），缺的那段按 0 补。
 * 不是数字、空串、超过三段（如 v1.2.3.4）一律返回 null——宁可说「不知道」，
 * 也不要把它当成 0.0.0 去和真实版本比。
 */
export function parseVersion(tag: string): ParsedVersion | null {
  const raw = (tag ?? '').trim().replace(/^[vV]/, '');
  if (!raw) return null;
  const parts = raw.split('.');
  if (parts.length < 1 || parts.length > 3) return null;
  const numbers: number[] = [];
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return null;
    numbers.push(Number(part));
  }
  return {
    major: numbers[0],
    minor: numbers[1] ?? 0,
    patch: numbers[2] ?? 0,
  };
}

/**
 * a 是否比 b 新：major → minor → patch 逐段比，缺段按 0 补。
 *
 * 任一边解析不出来就返回 false：查不到版本时宁可说「没有新版本」，绝不误报。
 */
export function isNewerVersion(a: string, b: string): boolean {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) return false;
  if (left.major !== right.major) return left.major > right.major;
  if (left.minor !== right.minor) return left.minor > right.minor;
  return left.patch > right.patch;
}

/** 安装包的类型：Chrome 装 zip，Firefox 装 xpi */
export type PackageKind = 'zip' | 'xpi';

/** 本仓库发版产物的命名前缀（scripts/package-chrome.mjs、package-firefox.mjs 产出的就是这个） */
const PACKAGE_PREFIX = 'pta-assistant-';

/**
 * 从 release 的资产里挑出安装包直链。
 *
 * 只认 `pta-assistant-` 开头、扩展名正好是 .zip / .xpi 的条目：
 * Gitee 上还挂着 `v5.1.0.zip`、`v5.1.0.tar.gz` 这两个源码包，名字不是安装包，
 * 认错了就会把源码包当成插件发给用户。
 */
export function pickPackageUrl(assets: ReleaseAsset[], kind: PackageKind): string {
  const suffix = `.${kind}`;
  for (const asset of assets ?? []) {
    const name = asset?.name ?? '';
    if (!name.startsWith(PACKAGE_PREFIX)) continue;
    if (!name.endsWith(suffix)) continue;
    const url = asset.browser_download_url ?? '';
    if (url) return url;
  }
  return '';
}
