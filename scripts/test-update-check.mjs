// 更新检测的纯逻辑单测：发版次数解析、比较、挑安装包。
// 这三段不依赖浏览器，也不联网，Node 剥掉类型后直接导入 .ts 就能测。
// 用法：node scripts/test-update-check.mjs
const { hasNewerRelease, parseReleaseCount, pickPackageUrl } = await import('../src/shared/update-check.ts');

const check = (label, ok, detail) => {
  if (!ok) {
    const extra = detail === undefined ? '' : `（实际：${JSON.stringify(detail).slice(0, 400)}）`;
    throw new Error(`✗ ${label}${extra}`);
  }
  console.log(`✓ ${label}`);
};

// ---- 1. 发版次数解析 ----
check('标题里的发版次数解析出来', parseReleaseCount('V7.1.12@133') === 133, parseReleaseCount('V7.1.12@133'));
check('只有版本号时没有次数', parseReleaseCount('v7.1.12') === null, parseReleaseCount('v7.1.12'));
check('空标题没有次数', parseReleaseCount('') === null, parseReleaseCount(''));
check('@ 后面不是数字没有次数', parseReleaseCount('v1.2.3@beta') === null, parseReleaseCount('v1.2.3@beta'));
check('@ 后面是 0 不算有效次数', parseReleaseCount('v1.2.3@0') === null, parseReleaseCount('v1.2.3@0'));
check('前后有空白也认', parseReleaseCount('  PTA 助手 V7.1.12@133  ') === 133, parseReleaseCount('  PTA 助手 V7.1.12@133  '));

// ---- 2. 按次数比新旧 ----
check('远端次数更大算有更新', hasNewerRelease(132, 'V7.1.12@133') === true);
check('次数相同不算更新', hasNewerRelease(133, 'V7.1.12@133') === false);
check('本地次数更大不算更新', hasNewerRelease(134, 'V7.1.12@133') === false);
check('远端标题解析不出次数时不误报', hasNewerRelease(1, 'v7.1.12') === false);
check('内置次数缺失（0）时能识别出任何带次数的发版', hasNewerRelease(0, 'V1.0@1') === true);

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
