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
 * 从 release 标题里取「发版次数」：作者把标题写成 `V7.1.12@133` 这种形式。
 *
 * 为什么要按次数而不是版本号比：版本号是作者随手写的（有 v3.1 这种两段的、
 * 也有跳号的），比大小容易漏版本；发版次数每次 +1，单调递增，比它更可靠。
 *
 * 不是 `@数字` 形式一律返回 null——宁可说「不知道」，也不误报有更新。
 */
export function parseReleaseCount(title: string): number | null {
  const match = /@(\d+)/.exec((title ?? '').trim());
  if (!match) return null;
  const count = Number(match[1]);
  return Number.isInteger(count) && count > 0 ? count : null;
}

/**
 * 远端是不是比内置的这份新：远端的发版次数更大才算。
 *
 * 任一解析不出来就返回 false：查不到时宁可说「没有新版本」，绝不误报。
 */
export function hasNewerRelease(builtinCount: number, remoteTitle: string): boolean {
  const remote = parseReleaseCount(remoteTitle);
  if (remote === null) return false;
  const local = Number.isFinite(builtinCount) ? builtinCount : 0;
  return local < remote;
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
