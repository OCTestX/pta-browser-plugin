// Firefox 暴露的是 browser（Promise 风格），Chrome 暴露的是 chrome（MV3 同样返回 Promise）。
// 统一取一个入口，业务代码只用 ext.xxx。
export const ext: typeof chrome = ((globalThis as unknown as { browser?: typeof chrome }).browser ??
  (globalThis as unknown as { chrome?: typeof chrome }).chrome) as typeof chrome;
