// 讲解页（/what 生成的那份自包含 HTML）的纯逻辑。
//
// 这个文件刻意不 import 任何用到 chrome.* 的模块：
// 它要被 scripts/test-explain.mjs 直接在 node 里 import 做单测，
// 一旦沾上 chrome.*，node 会在 import 阶段就炸。
//
// 背景（实体解码）：
// HTML 里 <script> / <style> 是 raw-text 元素——它们的内容按纯文本解析，
// 里面的 HTML 实体不会被解码。模型为了「安全」经常把 > 写成 &gt;、< 写成 &lt、
// & 写成 &amp;，结果就是：
//   · 页面正文里冒出字面的 &gt;
//   · <script> 里的 "当 A &gt; B 时" 变成字符串里带着 &gt; 的怪文本。
// 所以这里只对 script/style 的「内容部分」做一层实体解码，
// 正文（script/style 之外）原样不动——正文里的实体浏览器自己会解。

/** 讲解页在 storage.local 里的键前缀 */
export const EXPLAIN_STORAGE_PREFIX = 'pta-assistant-explain:';

/** 讲解页在 storage.local 里的完整键 */
export function explainStorageKey(pageId: string): string {
  return EXPLAIN_STORAGE_PREFIX + pageId;
}

/** raw-text 元素：内容不做实体解码 */
const RAW_TEXT_TAGS = ['script', 'style'] as const;
type RawTextTag = (typeof RAW_TEXT_TAGS)[number];

/** 只解这些具名实体，其余（&copy; 之类）保持原样 */
const NAMED_ENTITIES: Record<string, string | undefined> = {
  lt: '<',
  gt: '>',
  amp: '&',
  quot: '"',
  apos: "'",
  nbsp: '\u00a0',
};

/** 形如 &lt; / &#62; / &#x3E; 的实体 */
const ENTITY_PATTERN = /&(#[0-9]+|#[xX][0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g;

/** 解一个实体；不认识就返回 undefined（调用方原样保留） */
function decodeOneEntity(body: string): string | undefined {
  if (body.startsWith('#')) {
    const isHex = body[1] === 'x' || body[1] === 'X';
    const code = Number.parseInt(isHex ? body.slice(2) : body.slice(1), isHex ? 16 : 10);
    // 越界、代理区、无效码点一律不解
    if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return undefined;
    if (code >= 0xd800 && code <= 0xdfff) return undefined;
    return String.fromCodePoint(code);
  }
  return NAMED_ENTITIES[body.toLowerCase()];
}

/** 引号扫描器：判断「当前这段文字是不是在字符串里、用的是哪种引号」 */
type Quote = '"' | "'" | '`';

interface QuoteScanner {
  /** 吃掉一段普通文本，推进状态 */
  consume(text: string): void;
  /** 当前所在字符串的引号；不在字符串里就是 null */
  currentQuote(): Quote | null;
}

/** JS 扫描器：认单引号、双引号、反引号三种引号，以及行注释与块注释 */
function createJsScanner(): QuoteScanner {
  let quote: Quote | null = null;
  let escaped = false;
  return {
    consume(text: string): void {
      for (let i = 0; i < text.length; i++) {
        const ch = text.charAt(i);
        if (quote !== null) {
          if (escaped) {
            escaped = false;
            continue;
          }
          if (ch === '\\') {
            escaped = true;
            continue;
          }
          if (ch === quote) {
            quote = null;
            continue;
          }
          // 单双引号的字符串不能跨行，遇到换行说明这个引号没闭合
          if (quote !== '`' && ch === '\n') quote = null;
          continue;
        }
        if (ch === '/' && text.charAt(i + 1) === '/') {
          while (i < text.length && text.charAt(i) !== '\n') i++;
          continue;
        }
        if (ch === '/' && text.charAt(i + 1) === '*') {
          i += 2;
          while (i < text.length && !(text.charAt(i) === '*' && text.charAt(i + 1) === '/')) i++;
          i++;
          continue;
        }
        if (ch === '"' || ch === "'" || ch === '`') quote = ch;
      }
    },
    currentQuote: () => quote,
  };
}

/** CSS 扫描器：认单引号、双引号两种引号，以及块注释 */
function createCssScanner(): QuoteScanner {
  let quote: '"' | "'" | null = null;
  let escaped = false;
  return {
    consume(text: string): void {
      for (let i = 0; i < text.length; i++) {
        const ch = text.charAt(i);
        if (quote !== null) {
          if (escaped) {
            escaped = false;
            continue;
          }
          if (ch === '\\') {
            escaped = true;
            continue;
          }
          if (ch === quote) {
            quote = null;
            continue;
          }
          if (ch === '\n') quote = null;
          continue;
        }
        if (ch === '/' && text.charAt(i + 1) === '*') {
          i += 2;
          while (i < text.length && !(text.charAt(i) === '*' && text.charAt(i + 1) === '/')) i++;
          i++;
          continue;
        }
        if (ch === '"' || ch === "'") quote = ch;
      }
    },
    currentQuote: () => quote,
  };
}

function createScanner(tag: RawTextTag): QuoteScanner {
  return tag === 'script' ? createJsScanner() : createCssScanner();
}

/** 从 from 处往后看，是不是闭合标签（</script / </style） */
function startsCloseTag(text: string, from: number, tag: string): boolean {
  const rest = text.slice(from);
  return new RegExp('^/' + tag + '(?=[&\\s/>]|$)', 'i').test(rest);
}

/**
 * 解一层实体。
 *
 * 「一层」是关键：&amp;lt; 只能解成 &lt;，不能继续解成 <。
 * 扫的是原串、匹配完就跳过整段匹配的，所以解出来的 & 不会被二次扫描，
 * 天然满足「一层」。
 *
 * 两处保护，都是为了「解完不能把脚本写坏」：
 *   · 解出来的 '<' 如果正好拼成 </script，会把脚本拦腰截断 → 这种 &lt; 不解；
 *   · 解出来的引号如果正好是当前字符串的定界引号，会把字符串截断
 *     （"他说 &quot;你好&quot;" → "他说 "你好"" 直接语法错误）→ 改成转义写法。
 */
function decodeEntitiesOnce(text: string, tag: RawTextTag): string {
  const scanner = createScanner(tag);
  const pattern = new RegExp(ENTITY_PATTERN.source, 'g');
  let out = '';
  let cursor = 0;
  let match = pattern.exec(text);
  while (match !== null) {
    const [whole, body] = match;
    const start = match.index;
    out += text.slice(cursor, start);
    scanner.consume(text.slice(cursor, start));
    cursor = start + whole.length;

    const decoded = decodeOneEntity(body);
    if (decoded === undefined) {
      out += whole;
    } else if (decoded === '<' && startsCloseTag(text, cursor, tag)) {
      // 解开就是闭合标签，脚本会被截断，宁可留着不解
      out += whole;
    } else if (decoded === '"' || decoded === "'") {
      if (scanner.currentQuote() === decoded) {
        // 同一对引号：写成转义形式，字符串不断，值也变成真正的引号
        out += '\\' + decoded;
      } else {
        // 解出来的引号不再改扫描器的状态：
        // 状态只跟着原文里的引号走，模型写成 &quot; 的地方不该被当成新字符串的开头
        out += decoded;
      }
    } else {
      out += decoded;
    }
    match = pattern.exec(text);
  }
  return out + text.slice(cursor);
}

/** 找到标签的 '>'，跳过引号里的内容（属性值里可能有 '>'） */
function findTagEnd(html: string, from: number): number {
  let quote: string | null = null;
  for (let i = from; i < html.length; i++) {
    const ch = html.charAt(i);
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '>') return i;
  }
  return -1;
}

/** 在 lt 处是不是 script/style 开标签（要求标签名后是空白、'/' 或 '>'） */
function matchRawTextTag(html: string, lt: number): RawTextTag | null {
  for (const tag of RAW_TEXT_TAGS) {
    const name = html.slice(lt + 1, lt + 1 + tag.length);
    if (name.toLowerCase() !== tag) continue;
    const next = html.charAt(lt + 1 + tag.length);
    if (next === '' || next === '>' || next === '/' || /\s/.test(next)) return tag;
  }
  return null;
}

/** 找对应的闭合标签起始位置（</script、</style） */
function findCloseTag(html: string, tag: string, from: number): number {
  // 用正则而不是 html.toLowerCase()：某些 Unicode 字符小写化后长度会变，
  // 整串小写再 indexOf 会把位置对错
  const pattern = new RegExp('</' + tag + '(?=[\\s/>])', 'gi');
  pattern.lastIndex = from;
  const found = pattern.exec(html);
  return found ? found.index : -1;
}

/**
 * 把 <script>/<style> 内容里的 HTML 实体解一层。
 *
 * 只动 raw-text 元素的内容部分：标签名、属性、正文都不动。
 */
export function decodeRawTextEntities(html: string): string {
  if (!html) return html;
  let out = '';
  let cursor = 0;
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt < 0) break;
    const tag = matchRawTextTag(html, lt);
    if (!tag) {
      i = lt + 1;
      continue;
    }
    const openEnd = findTagEnd(html, lt + 1 + tag.length);
    if (openEnd < 0) break;
    const contentStart = openEnd + 1;
    const closeStart = findCloseTag(html, tag, contentStart);
    if (closeStart < 0) break; // 没闭合就整段不动
    out += html.slice(cursor, contentStart);
    out += decodeEntitiesOnce(html.slice(contentStart, closeStart), tag);
    cursor = closeStart;
    i = closeStart;
  }
  return out + html.slice(cursor);
}

/**
 * 把一段 HTML 塞进 HTML 属性的值里时的转义。
 *
 * 结论（已在 node + jsdom 上实测）：
 *   · '<' 与 '>' 在双引号属性值里可以原样放行——HTML 解析器在属性值状态
 *     不把它们当标签起始，实测 srcdoc="a<b>c" 取出来仍是 a<b>c；
 *   · '&' 必须转义：属性值里的 '&' 是字符引用的开头，
 *     实测 srcdoc="&lt;b&gt;" 取出来是 <b>（被解了一层）；
 *   · '"' 必须转义，否则会提前结束属性值。
 *
 * 转义 '&' 还有一层好处：外层解析器会把 &amp; 解回 '&'，
 * 于是 srcdoc 文档拿到的原始实体（&gt;、&amp;）保持不变，
 * 不会因为「属性解一层 + 文档再解一层」而多解一次。
 *
 * 注意：讲解页的实际渲染路径不需要这个函数——那里走
 * iframe.setAttribute('srcdoc', html)（DOM 赋值，字符串原样进入 srcdoc，
 * 没有「属性再解一层」的问题）。这个函数留给需要把 srcdoc 拼进 HTML 源码字符串的场合。
 */
export function escapeAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

/**
 * 讲解页放在 PTA 自己的站点上，而不是扩展页。
 *
 * 为什么不能放在扩展页（chrome-extension://…/explain.html）：
 * 扩展页的 CSP 是 `script-src 'self' 'wasm-unsafe-eval'`，Chrome **不允许**在扩展页 CSP 里写
 * 'unsafe-inline'（实测各种写法都被清单校验拒绝），而 blob: 脚本也被 script-src-elem 拦掉。
 * 也就是说扩展页里一行模型产的 <script> 都跑不起来，讲解页会只剩静态正文。
 *
 * 所以讲解页开在 pintia.cn 的一个固定路径上：内容脚本认出这个路径后，
 * 把模型产的 HTML 装进**沙箱 iframe**（不给 allow-same-origin → 不透明来源，
 * 拿不到 chrome.*、拿不到 cookie、读不到父页面）。
 * PTA 没有发 CSP 头，srcdoc 继承不到限制，模型产的脚本能正常跑。
 */
export const EXPLAIN_PAGE_PATH = '/pta-assistant/explain';

/** 讲解页的地址：https://pintia.cn/pta-assistant/explain?id=xxx */
export function buildExplainUrl(pageId: string, origin = 'https://pintia.cn'): string {
  return `${origin.replace(/\/+$/, '')}${EXPLAIN_PAGE_PATH}?id=${encodeURIComponent(pageId)}`;
}

/** 从地址里认出「这是讲解页」，并取出 pageId；不是讲解页就返回 null */
export function parseExplainPageId(href: string, origin = 'https://pintia.cn'): string | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  // 站点也要对：内容脚本跑在所有页面上，光看路径会把别的网站也当成讲解页
  if (url.origin !== new URL(origin).origin) return null;
  if (url.pathname !== EXPLAIN_PAGE_PATH) return null;
  const id = url.searchParams.get('id');
  return id && id.trim() ? id.trim() : null;
}
