import type { ToolRunResponse } from '../shared/messages';

/** 需要页面上下文才能执行的工具：url 和 write_document 都在这里 */
export function runPageTool(name: string, args: Record<string, unknown>): ToolRunResponse {
  if (name === 'url') return { ok: true, result: window.location.href };
  if (name === 'write_document') return writeDocument(args);
  return { ok: false, result: `未知工具：${name}` };
}

function writeDocument(args: Record<string, unknown>): ToolRunResponse {
  const content = typeof args.content === 'string' ? args.content : '';
  if (!content.trim()) return { ok: false, result: '缺少 content 参数' };

  const filename = sanitizeFilename(
    typeof args.filename === 'string' && args.filename.trim() ? args.filename : 'PTA-助手文档.txt',
  );
  const url = URL.createObjectURL(new Blob([content], { type: 'text/plain;charset=utf-8' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.style.display = 'none';

  // 必须挂进文档里，Firefox 才会真的触发下载
  document.documentElement.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);

  return { ok: true, result: `已触发下载：${filename}（${content.length} 字符）` };
}

/** 文件名里的路径分隔符和控制字符会让浏览器拒绝下载 */
function sanitizeFilename(filename: string): string {
  // eslint 风格的正则：去掉路径分隔符与控制字符
  return filename.replace(/[/\\:*?"<>|\u0000-\u001f]/g, '_').slice(0, 120);
}
