// 跳转前的安全判定：只放行同源的 http(s) 地址。
// 纯逻辑，Node 剥类型后直接导入 .ts。
// 用法：node scripts/test-navigation.mjs
import { canNavigateTo, originOf } from '../src/shared/navigation.ts';

const check = (label, ok, detail) => {
  if (!ok) {
    console.error(`✗ ${label}`, detail ?? '');
    process.exit(1);
  }
  console.log(`✓ ${label}`);
};

const PAGE = 'https://pintia.cn/problem-sets/123/exam/problems/type/7?problemSetProblemId=456';

check('同源的题目地址可以跳', canNavigateTo(PAGE, PAGE));
check('同一站点别的题也能跳', canNavigateTo('https://pintia.cn/problem-sets/999/exam/problems/type/1', PAGE));
check('别的站点不能跳', !canNavigateTo('https://example.com/phishing', PAGE));
check('http 页面不能跳到 https 站点（同源判定含协议）', !canNavigateTo('http://pintia.cn/x', PAGE));
check('javascript: 不能跳', !canNavigateTo('javascript:alert(1)', PAGE));
check('data: 不能跳', !canNavigateTo('data:text/html,<script>alert(1)</script>', PAGE));
check('空地址不能跳', !canNavigateTo('', PAGE));
check('不是地址的字符串不能跳', !canNavigateTo('题目 3 的地址', PAGE));
check('当前页面地址不明时一律不跳', !canNavigateTo(PAGE, ''));
check('当前页面地址不明时连同源的也不跳', !canNavigateTo(PAGE, 'not a url'));

check('取源：正常地址', originOf('https://pintia.cn/a/b?c=1') === 'https://pintia.cn', originOf('https://pintia.cn/a/b?c=1'));
check('取源：端口算进源里', originOf('http://127.0.0.1:8899/x') === 'http://127.0.0.1:8899', originOf('http://127.0.0.1:8899/x'));
check('取源：坏地址返回空串', originOf('???') === '', originOf('???'));

console.log('\n跳转判定通过');
