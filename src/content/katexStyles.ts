import rawKatexCss from 'katex/dist/katex.min.css?raw';
import { ext } from '../shared/browser';

const FONT_DIR = 'katex-fonts/';

let cached: string | null = null;

/**
 * KaTeX 自带样式里的 url(fonts/xxx.woff2) 是相对路径，注入到页面里会以页面为基准去请求（必然 404）。
 * 这里改写成扩展自己的地址；字库文件由构建脚本复制到 dist/<target>/katex-fonts/，
 * 并在 manifest 的 web_accessible_resources 里声明，否则 Chrome 会拦掉。
 */
export function katexStyles(): string {
  if (cached === null) {
    const base = ext.runtime.getURL(FONT_DIR);
    cached = rawKatexCss.replace(
      /url\((['"]?)fonts\//g,
      (_match, quote: string) => `url(${quote}${base}`,
    );
  }
  return cached;
}
