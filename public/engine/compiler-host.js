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

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === 'engine-request') {
    ensureWorker().postMessage(message.data);
  } else if (message?.type === 'engine-restart') {
    if (worker) worker.terminate();
    worker = null;
    ensureWorker();
  }
  // 其他消息不归这里管（显式返回 undefined）
  return undefined;
});

ensureWorker();
