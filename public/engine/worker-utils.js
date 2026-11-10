/**
 * 把标准输入切成按行喂给 Pyodide 的回调。
 *
 * Pyodide 的 stdin 回调只在返回 null / undefined 时表示 EOF；返回空字符串
 * 会被当成「还有一行空行」，`sys.stdin.read()` 会一直回调下去，把 worker
 * 线程同步堵死。末尾的换行不额外产生一行，空输入第一次调用就返回 null。
 */
export function makeStdinReader(stdin) {
  const lines = String(stdin || '').split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  let lineIndex = 0;
  return () => (lineIndex < lines.length ? `${lines[lineIndex++]}\n` : null);
}
