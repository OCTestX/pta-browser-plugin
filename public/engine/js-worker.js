// 内置 JavaScript 运行器：在 Web Worker 里跑一段 JS，捕获 stdout/stderr。
// 通过 postMessage({id, code, stdin}) 触发，回 {id, type:'done', result}。
self.onmessage = async (event) => {
  const { id, code, stdin } = event.data || {};
  const lines = (stdin || '').split('\n');
  let stdinIndex = 0;
  const readline = () => (stdinIndex < lines.length ? lines[stdinIndex++] : '');
  const stdout = [];
  const stderr = [];
  const console = {
    log: (...a) => stdout.push(a.map(String).join(' ')),
    error: (...a) => stderr.push(a.map(String).join(' ')),
    warn: (...a) => stderr.push(a.map(String).join(' ')),
  };
  let error = null;
  const started = Date.now();
  try {
    // eslint-disable-next-line no-new-func
    const fn = new Function('console', 'readline', 'stdin', code);
    const r = fn(console, readline, stdin || '');
    if (r !== undefined) stdout.push(String(r));
  } catch (e) {
    error = (e && e.message) || String(e);
  }
  self.postMessage({
    id,
    type: 'done',
    result: {
      stdout: stdout.join('\n') + (stdout.length ? '\n' : ''),
      stderr: stderr.join('\n') + (stderr.length ? '\n' : ''),
      error,
      elapsedMs: Date.now() - started,
    },
  });
};
