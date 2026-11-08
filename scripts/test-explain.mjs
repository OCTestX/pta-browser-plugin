// 讲解页的纯逻辑校验：raw-text 实体的单层解码 + 讲解页地址的拼装。
// 用法：node scripts/test-explain.mjs
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildExplainUrl,
  parseExplainPageId,
  decodeRawTextEntities,
  escapeAttribute,
} from '../src/shared/explain-html.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(path.join(root, rel), 'utf8');

const check = (label, ok) => {
  if (!ok) throw new Error(`✗ ${label}`);
  console.log(`✓ ${label}`);
};

/* ---------- script / style 里的实体要解一层 ---------- */

const scripted = decodeRawTextEntities(
  '<script>var t = "当 A &gt; B 时"; if (a &lt; b) { c(); }</script>',
);
check('script 里的 &gt; 被解成 >', scripted.includes('"当 A > B 时"'));
check('script 里的 &lt; 被解成 <', scripted.includes('if (a < b)'));
check('script 里的 &amp; 被解成 &', decodeRawTextEntities('<script>x = a &amp;&amp; b;</script>').includes('a && b'));

const styled = decodeRawTextEntities('<style>.a::after{content:"&gt;"}</style>');
check('style 里的 &gt; 被解成 >', styled.includes('content:">"'));

/* ---------- script / style 之外一律不动 ---------- */

const withBody = decodeRawTextEntities('<p>当 A &gt; B 时</p><script>var t = "&gt;";</script>');
check('正文里的 &gt; 保持原样', withBody.includes('<p>当 A &gt; B 时</p>'));
check('正文里的实体没有被顺带解掉', !withBody.includes('<p>当 A > B 时</p>'));
check('标签名与属性不动', decodeRawTextEntities('<script src="a.js" type="text/javascript"></script>')
  === '<script src="a.js" type="text/javascript"></script>');

/* ---------- 只解一层，不能递归 ---------- */

check('&amp;lt; 只解一层成 &lt;', decodeRawTextEntities('<script>&amp;lt;</script>') === '<script>&lt;</script>');
check('&amp;gt; 只解一层成 &gt;', decodeRawTextEntities('<script>&amp;gt;</script>') === '<script>&gt;</script>');
check('&amp;amp; 只解一层成 &amp;', decodeRawTextEntities('<script>&amp;amp;</script>') === '<script>&amp;</script>');

/* ---------- 数字实体 ---------- */

check('&#62; 解成 >', decodeRawTextEntities('<script>&#62;</script>') === '<script>></script>');
check('&#x3E; 解成 >', decodeRawTextEntities('<script>&#x3E;</script>') === '<script>></script>');
check('&#39; 解成 \'', decodeRawTextEntities('<script>&#39;</script>') === "<script>'</script>");
check('&quot; 解成 "', decodeRawTextEntities('<script>&quot;</script>') === '<script>"</script>');
check('&nbsp; 解成不换行空格', decodeRawTextEntities('<script>&nbsp;</script>') === '<script> </script>');
check('未知实体原样保留', decodeRawTextEntities('<script>&copy;</script>') === '<script>&copy;</script>');
check('不是实体的 & 保持原样', decodeRawTextEntities('<script>a && b</script>') === '<script>a && b</script>');

/* ---------- 杂项：属性里有 '>'、大小写、未闭合 ---------- */

check(
  'script 属性里带 > 也能找到内容',
  decodeRawTextEntities('<script data-x="a>b">var t = "&gt;";</script>').includes('var t = ">";'),
);
check('大写 SCRIPT 也认', decodeRawTextEntities('<SCRIPT>&gt;</SCRIPT>') === '<SCRIPT>></SCRIPT>');
check('没闭合的 script 整段不动', decodeRawTextEntities('<script>&gt;') === '<script>&gt;');
check('空串安全', decodeRawTextEntities('') === '');

/* ---------- 不能把脚本提前闭合 ---------- */

check(
  '解出来的 < 不会拼成 </script 把脚本截断',
  decodeRawTextEntities('<script>var s = "&lt;/script&gt;";</script>')
    === '<script>var s = "&lt;/script>";</script>',
);
check(
  '普通 &lt; 照常解',
  decodeRawTextEntities('<script>var s = "&lt;";</script>') === '<script>var s = "<";</script>',
);

/* ---------- 引号不能把字符串截断 ---------- */

check(
  '字符串里的 &quot; 写成转义形式，字符串不断',
  decodeRawTextEntities('<script>var s = "他说 &quot;你好&quot;";</script>')
    === '<script>var s = "他说 \\"你好\\"";</script>',
);
check(
  '字符串里的单引号实体同样转义',
  decodeRawTextEntities("<script>var s = 'it&apos;s';</script>")
    === "<script>var s = 'it\\'s';</script>",
);
check(
  '字符串外的 &quot; 照常解',
  decodeRawTextEntities('<script>var s = &quot;hi&quot;;</script>')
    === '<script>var s = "hi";</script>',
);
check(
  '注释里的 &quot; 也解（注释里没有语法约束）',
  decodeRawTextEntities('<script>// &quot; 注释\nvar a = 1;</script>')
    === '<script>// " 注释\nvar a = 1;</script>',
);

/* ---------- 讲解页地址：PTA 站点上的固定路径，不是 data: URL ---------- */

const url = buildExplainUrl('xxx');
check('地址形如 https://pintia.cn/pta-assistant/explain?id=xxx', url === 'https://pintia.cn/pta-assistant/explain?id=xxx');
check('地址里不含 data:', !url.includes('data:'));
check('origin 结尾带斜杠也不会多出斜杠', buildExplainUrl('xxx', 'https://pintia.cn/') === url);
check('pageId 里的特殊字符会被编码', buildExplainUrl('a b&c') === 'https://pintia.cn/pta-assistant/explain?id=a%20b%26c');

/* ---------- 能从地址里认出讲解页 ---------- */

check('认出讲解页地址', parseExplainPageId('https://pintia.cn/pta-assistant/explain?id=abc') === 'abc');
check('别的 PTA 页面不是讲解页', parseExplainPageId('https://pintia.cn/home') === null);
check('别的站点不是讲解页', parseExplainPageId('https://example.com/pta-assistant/explain?id=abc') === null);
check('没有 id 就不是讲解页', parseExplainPageId('https://pintia.cn/pta-assistant/explain') === null);
check('乱地址不炸', parseExplainPageId('不是地址') === null);

/* ---------- 属性转义的结论 ---------- */

// 实测（node + jsdom）：属性值里 '<' '>' 可以原样放行，'&' 会被当实体开头，'"' 会截断属性值
check('escapeAttribute 转义 & 与 "', escapeAttribute('a & "b"') === 'a &amp; &quot;b&quot;');
check('escapeAttribute 放行 < 与 >', escapeAttribute('<b>') === '<b>');

// 用 jsdom 把上面的结论钉死：srcdoc 的值是怎么进到属性里的
const { JSDOM } = await import('jsdom');
const attrDom = new JSDOM('<div id="host"></div>');
const host = attrDom.window.document.getElementById('host');
const raw = '<b>x</b> & "y"';
host.setAttribute('data-x', raw);
check('DOM 赋值时 srcdoc 原样进入属性，不解实体', host.getAttribute('data-x') === raw);
const parsed = new JSDOM(`<div data-x="${escapeAttribute(raw)}"></div>`);
check(
  '拼进 HTML 源码时 & 必须转义，否则会被当成实体开头',
  parsed.window.document.querySelector('div').getAttribute('data-x') === raw,
);
const parsedRaw = new JSDOM(`<div data-x="${raw.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"></div>`);
check(
  '拼进 HTML 源码时 < > 可以原样放行',
  parsedRaw.window.document.querySelector('div').getAttribute('data-x') === raw,
);

/* ---------- 内容脚本把内容塞进了沙箱 iframe ---------- */

const explainSrc = read('src/content/explain-mode.ts');
check('讲解页用了 sandbox', explainSrc.includes('sandbox'));
check(
  'sandbox 的取值里没有 allow-same-origin',
  !/setAttribute\('sandbox',\s*'[^']*allow-same-origin/.test(explainSrc),
);
check('讲解页把内容放进 srcdoc', explainSrc.includes('srcdoc'));
check('讲解页会设置标题', explainSrc.includes('document.title'));
check('讲解页有「已经不在了」的兜底提示', explainSrc.includes('这份讲解页已经不在了'));
check('讲解页认的是 PTA 上的固定路径', explainSrc.includes('parseExplainPageId'));

// 共享模块不能沾 chrome.*，否则 node 里 import 就炸
const sharedSrc = read('src/shared/explain-html.ts');
// 注释里提到 chrome 是为了说明「为什么不能引」，所以先把注释去掉再查
const sharedCode = sharedSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
check('共享模块不碰 chrome.*', !/\bchrome\b/.test(sharedCode));
check('共享模块没有 import 任何东西', !/^\s*import\s/m.test(sharedCode));
