import { memo } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import rehypeKatex from 'rehype-katex';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';

const remarkPlugins = [remarkGfm, remarkMath];
const rehypePlugins = [rehypeKatex];

const components: Components = {
  // 面板里点链接不该把 PTA 页面导航走
  a({ href, children }) {
    return (
      <a href={href} target="_blank" rel="noreferrer noopener">
        {children}
      </a>
    );
  },
};

interface MarkdownProps {
  content: string;
  /** 流式输出中：半截的代码围栏 / 公式要补全，否则整段会显示成纯文本 */
  streaming?: boolean;
}

export const Markdown = memo(function Markdown({ content, streaming = false }: MarkdownProps) {
  const source = streaming ? prepareMarkdown(content) : content;
  return (
    <ReactMarkdown
      remarkPlugins={remarkPlugins}
      rehypePlugins={rehypePlugins}
      components={components}
    >
      {source}
    </ReactMarkdown>
  );
});

/**
 * 流式过程中内容都是半截的，渲染前先规整：
 * 1. `\[ \]` `\( \)` 换成 remark-math 认的 `$$` / `$`
 * 2. 单行 `$$x$$` 拆成独占一行（micromark 只认独占一行的 `$$` 才算块级公式）
 * 3. 还没输出完的代码围栏和公式补上收尾，否则整段会退化成纯文本
 * 代码块里的内容一律不动，公式计数也不把代码块里的算进来。
 */
export function prepareMarkdown(text: string): string {
  let inFence = false;
  let displayMathCount = 0;
  const lines: string[] = [];

  for (const rawLine of text.split('\n')) {
    if (/^ {0,3}```/.test(rawLine)) {
      inFence = !inFence;
      lines.push(rawLine);
      continue;
    }
    if (inFence) {
      lines.push(rawLine);
      continue;
    }

    // 替换串里 $$ 是转义写法（会变成单个 $），一律用回调返回字面量
    const line = rawLine
      .replace(/\\\[|\\\]/g, () => '\n$$\n')
      .replace(/\\\(|\\\)/g, () => '$')
      .replace(/\$\$([^$]+)\$\$/g, (_match, body: string) => `\n$$\n${body.trim()}\n$$\n`);

    displayMathCount += line.match(/\$\$/g)?.length ?? 0;
    lines.push(line);
  }

  let prepared = lines.join('\n');
  if (((prepared.match(/^ {0,3}```/gm)?.length ?? 0) & 1) === 1) prepared += '\n```';

  if ((displayMathCount & 1) === 1) {
    // 计数为奇数时，最后一个 $$ 就是没配上的那个
    const tail = prepared.slice(prepared.lastIndexOf('$$'));
    // 半截公式后面已经跟了中文正文（比如回答被截断），就按普通文本处理：
    // 硬补收尾会把后面的正文一起吞进公式，KaTeX 会直接甩一个红色报错框
    if (!/[\u3400-\u9fff\uff00-\uffef]/.test(tail)) prepared += '\n$$\n';
  }

  return prepared;
}
