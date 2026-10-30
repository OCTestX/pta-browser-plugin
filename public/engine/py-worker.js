// 内置 Python 运行器：在 Web Worker 里用 Pyodide 跑一段 Python，捕获 stdout/stderr。
// 首次调用会从 CDN 加载 Pyodide（需要网络），之后复用。
let pyodide = null;
async function ensurePyodide() {
  if (pyodide) return pyodide;
  importScripts('https://cdn.jsdelivr.net/pyodide/v0.26.4/full/pyodide.js');
  pyodide = await loadPyodide({ indexURL: 'https://cdn.jsdelivr.net/pyodide/v0.26.4/full/' });
  return pyodide;
}

self.onmessage = async (event) => {
  const { id, code, stdin } = event.data || {};
  const started = Date.now();
  let stdout = '';
  let stderr = '';
  let error = null;
  try {
    const py = await ensurePyodide();
    py.setStdin({ stdin: () => (stdin || '') });
    // 捕获 stdout/stderr
    let outBuf = '';
    let errBuf = '';
    py.setStdout({ batched: (s) => { outBuf += s; } });
    py.setStderr({ batched: (s) => { errBuf += s; } });
    await py.runPythonAsync(code);
    stdout = outBuf;
    stderr = errBuf;
  } catch (e) {
    error = (e && e.message) || String(e);
  }
  self.postMessage({
    id,
    type: 'done',
    result: { stdout, stderr, error, elapsedMs: Date.now() - started },
  });
};
