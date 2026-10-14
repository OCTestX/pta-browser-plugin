// 测试跑的是构建产物，产物比源码旧的话测出来的东西根本不是刚改的代码——
// 这个坑踩过三次了，所以直接在测试开头拦掉。
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';

function newestMtime(dir) {
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) newest = Math.max(newest, newestMtime(full));
    else if (/\.(ts|tsx|css)$/.test(entry.name)) newest = Math.max(newest, statSync(full).mtimeMs);
  }
  return newest;
}

export function assertDistFresh(outDir) {
  let built;
  try {
    built = statSync(path.join(outDir, 'manifest.json')).mtimeMs;
  } catch {
    throw new Error(`✗ ${outDir} 里没有产物，先跑 npm run build（或直接用 npm test）`);
  }

  const newest = newestMtime('src');
  if (newest > built) {
    throw new Error(`✗ ${outDir} 比 src 旧（源码改过但没重新构建），先跑 npm run build`);
  }
}
