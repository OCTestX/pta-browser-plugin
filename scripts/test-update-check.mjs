// 更新检测的纯逻辑单测：版本号解析、比较、挑安装包。
// 这三段不依赖浏览器，也不联网，Node 剥掉类型后直接导入 .ts 就能测。
// 用法：node scripts/test-update-check.mjs
const { isNewerVersion, parseVersion, pickPackageUrl } = await import('../src/shared/update-check.ts');

const check = (label, ok, detail) => {
  if (!ok) {
    const extra = detail === undefined ? '' : `（实际：${JSON.stringify(detail).slice(0, 400)}）`;
    throw new Error(`✗ ${label}${extra}`);
  }
  console.log(`✓ ${label}`);
};

// ---- 1. 版本号解析 ----
check(
  'v6.9.0 解析成 6/9/0',
  JSON.stringify(parseVersion('v6.9.0')) === JSON.stringify({ major: 6, minor: 9, patch: 0 }),
  parseVersion('v6.9.0'),
);
check(
  '没有 v 前缀也能解析',
  JSON.stringify(parseVersion('6.9.0')) === JSON.stringify({ major: 6, minor: 9, patch: 0 }),
  parseVersion('6.9.0'),
);
check(
  '两段版本 v3.1 按 3.1.0 处理',
  JSON.stringify(parseVersion('v3.1')) === JSON.stringify({ major: 3, minor: 1, patch: 0 }),
  parseVersion('v3.1'),
);
check(
  '两段版本 v2.0 按 2.0.0 处理',
  JSON.stringify(parseVersion('v2.0')) === JSON.stringify({ major: 2, minor: 0, patch: 0 }),
  parseVersion('v2.0'),
);
check('非版本号解析不出来', parseVersion('abc') === null, parseVersion('abc'));
check('空串解析不出来', parseVersion('') === null, parseVersion(''));
check('超过三段解析不出来', parseVersion('v1.2.3.4') === null, parseVersion('v1.2.3.4'));
check('带非数字的段解析不出来', parseVersion('v1.2.beta') === null, parseVersion('v1.2.beta'));

// ---- 2. 版本比较 ----
check('补丁号更大算更新', isNewerVersion('v6.9.1', 'v6.9.0') === true);
check('相同版本不算更新', isNewerVersion('v6.9.0', 'v6.9.0') === false);
check('远端更旧不算更新', isNewerVersion('v6.8.8', 'v6.9.0') === false);
check('次版本号更大算更新', isNewerVersion('v6.10.0', 'v6.9.0') === true);
check('次版本号更小不算更新', isNewerVersion('v6.9.0', 'v6.10.0') === false);
check('主版本号更大算更新', isNewerVersion('v7.0', 'v6.9.0') === true);
check('解析不出来时不误报有更新', isNewerVersion('abc', 'v6.9.0') === false);
check('本地版本解析不出来时也不误报', isNewerVersion('v6.9.0', 'abc') === false);

// ---- 3. 从 release 资产里挑安装包 ----
// Gitee 上同时挂着安装包与源码包（v5.1.0.zip / v5.1.0.tar.gz），不能挑错
const giteeAssets = [
  {
    name: 'pta-assistant-v5.1.0.zip',
    browser_download_url: 'https://gitee.com/octestx/pta-browser-plugin/releases/download/v5.1.0/pta-assistant-v5.1.0.zip',
  },
  {
    name: 'pta-assistant-v5.1.0.xpi',
    browser_download_url: 'https://gitee.com/octestx/pta-browser-plugin/releases/download/v5.1.0/pta-assistant-v5.1.0.xpi',
  },
  {
    name: 'v5.1.0.zip',
    browser_download_url: 'https://gitee.com/octestx/pta-browser-plugin/archive/refs/tags/v5.1.0.zip',
  },
  {
    name: 'v5.1.0.tar.gz',
    browser_download_url: 'https://gitee.com/octestx/pta-browser-plugin/archive/refs/tags/v5.1.0.tar.gz',
  },
];
check(
  'Chrome 挑 zip 安装包（不是源码包）',
  pickPackageUrl(giteeAssets, 'zip')
    === 'https://gitee.com/octestx/pta-browser-plugin/releases/download/v5.1.0/pta-assistant-v5.1.0.zip',
  pickPackageUrl(giteeAssets, 'zip'),
);
check(
  'Firefox 挑 xpi 安装包',
  pickPackageUrl(giteeAssets, 'xpi')
    === 'https://gitee.com/octestx/pta-browser-plugin/releases/download/v5.1.0/pta-assistant-v5.1.0.xpi',
  pickPackageUrl(giteeAssets, 'xpi'),
);
check('没有资产时返回空串', pickPackageUrl([], 'zip') === '');
check('只有源码包时不返回源码包的地址', pickPackageUrl(giteeAssets.slice(2), 'zip') === '');

console.log('\n全部通过');
