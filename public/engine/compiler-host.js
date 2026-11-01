// offscreen 页脚本（仅 Chrome 用）：MV3 的 service worker 里建不了 Worker，
// 由这个常驻隐藏页承载编译 Worker，把后台发来的请求转进去、把结果转回来。
//
// 协议（chrome.runtime.sendMessage）：
//   收 { type: 'engine-request', data }  → 转发给 Worker
//      { type: 'engine-restart' }        → 杀掉 Worker 重开（超时后用）
//   发 { type: 'engine-message', data }  → Worker 的回复原样转给后台

let worker = null;

function ensureWorker() {
  if (worker) return worker;
  worker = new Worker(new URL('compile-worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = (ev) => {
    void chrome.runtime.sendMessage({ type: 'engine-message', data: ev.data })
      .catch(() => undefined); // 后台正在重启时收不到就算了，超时机制会兜底
  };
  worker.onerror = () => {
    // Worker 整体崩掉：置空，下个请求重建；在飞的请求由后台超时兜底
    if (worker) worker.terminate();
    worker = null;
    ensureWorker();
  };
  return worker;
}

// 剪贴板兜底：content script 读不到剪贴板时（例如页面抢了快捷键），
// 后台让这一页用 execCommand('paste') 读（manifest 里申请了 clipboardRead）。
// 同一个 offscreen 文档既承载编译 Worker，也做这件事（Chrome 只允许开一个）。
function readClipboardViaExecCommand() {
  const area = document.createElement('textarea');
  area.value = '';
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.top = '-1000px';
  area.style.opacity = '0';
  document.body.appendChild(area);
  area.focus();
  area.select();
  let ok = false;
  try {
    ok = document.execCommand('paste');
  } catch {
    ok = false;
  }
  const text = area.value;
  area.remove();
  return { ok, text };
}

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === 'engine-request') {
    ensureWorker().postMessage(message.data);
  } else if (message?.type === 'engine-restart') {
    if (worker) worker.terminate();
    worker = null;
    ensureWorker();
  } else if (message?.type === 'clipboard-read-request' && typeof message.id === 'string') {
    try {
      const result = readClipboardViaExecCommand();
      void chrome.runtime
        .sendMessage({
          type: 'clipboard-read-response',
          id: message.id,
          ok: result.ok,
          text: result.text,
          message: result.ok ? undefined : '浏览器拒绝读取剪贴板（execCommand paste 被拦）',
        })
        .catch(() => undefined);
    } catch (error) {
      void chrome.runtime
        .sendMessage({
          type: 'clipboard-read-response',
          id: message.id,
          ok: false,
          message: String(error),
        })
        .catch(() => undefined);
    }
  }
  // 其他消息不归这里管（显式返回 undefined）
  return undefined;
});

ensureWorker();
