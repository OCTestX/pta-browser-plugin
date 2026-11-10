// 标签页级存储：草稿与对话按标签页隔离，不按 URL。
//
// sessionStorage 天然按标签页隔离，所以这里用两个独立的 fake sessionStorage
// 模拟 A/B 两个标签页。模块在加载时绑定当时的 sessionStorage，带查询串重新
// import 就等于「刷新同一个标签页」或「新开一个标签页」。
//
// 用法：node scripts/test-tab-store.mjs

const check = (label, ok, detail) => {
  if (!ok) {
    const extra = detail === undefined ? '' : `（实际：${JSON.stringify(detail).slice(0, 400)}）`;
    throw new Error(`✗ ${label}${extra}`);
  }
  console.log(`✓ ${label}`);
};

function fakeSessionStorage() {
  const data = new Map();
  return {
    get length() {
      return data.size;
    },
    key: (index) => [...data.keys()][index] ?? null,
    getItem: (key) => (data.has(String(key)) ? data.get(String(key)) : null),
    setItem: (key, value) => {
      data.set(String(key), String(value));
    },
    removeItem: (key) => {
      data.delete(String(key));
    },
    clear: () => data.clear(),
  };
}

// 每次 import 前把全局 sessionStorage 换成对应标签页的那份
const loadPanel = (tag) => import(`../src/content/panelStore.ts?${tag}`);
const loadChat = (tag) => import(`../src/content/chatStore.ts?${tag}`);

// 两个标签页开的是同一个地址：证明隔离靠标签页，不靠 URL
globalThis.location = {
  href: 'https://pintia.cn/problem-sets/1/problems/2',
  origin: 'https://pintia.cn',
  pathname: '/problem-sets/1/problems/2',
  search: '',
};

const message = (id, role, content, extra = {}) => ({ id, role, content, createdAt: 1, ...extra });
const texts = (messages) => messages.map((item) => item.content).join('|');

const storageA = fakeSessionStorage();
const storageB = fakeSessionStorage();

/* ---------- 标签页 A：写草稿与对话 ---------- */

globalThis.sessionStorage = storageA;
const panelA = await loadPanel('tab=a');
const chatA = await loadChat('tab=a');

panelA.setDraft('A 的草稿：同一道题');
await chatA.saveMessages([
  message('a1', 'user', 'A 的提问'),
  message('a2', 'assistant', 'A 的回答', { streaming: true }),
]);
await chatA.saveMessages([message('a3', 'user', '赶题中的提问')], chatA.runConversationKey('req-A'));

check('A 标签页刚写入的草稿读得回来', panelA.getDraft() === 'A 的草稿：同一道题', panelA.getDraft());
check('A 标签页的对话写进去了', texts(await chatA.loadMessages()) === 'A 的提问|A 的回答');

/* ---------- 标签页 B：同一个 URL，从空开始 ---------- */

globalThis.sessionStorage = storageB;
const panelB = await loadPanel('tab=b');
const chatB = await loadChat('tab=b');

check('同 URL 的新标签页草稿是空的', panelB.getDraft() === '', panelB.getDraft());
check('同 URL 的新标签页对话是空的', (await chatB.loadMessages()).length === 0);
check('新标签页也看不到 A 的赶题桶', (await chatB.loadMessages(chatB.runConversationKey('req-A'))).length === 0);

panelB.setDraft('B 的草稿：另一份');
await chatB.saveMessages([message('b1', 'user', 'B 的提问')]);

check('B 标签页读得到自己的草稿', panelB.getDraft() === 'B 的草稿：另一份', panelB.getDraft());
check('B 标签页读得到自己的对话', texts(await chatB.loadMessages()) === 'B 的提问');

/* ---------- 两个标签页互不覆盖 ---------- */

check('B 写入后 A 的草稿没被串掉', panelA.getDraft() === 'A 的草稿：同一道题', panelA.getDraft());
check('B 写入后 A 的对话没被串掉', texts(await chatA.loadMessages()) === 'A 的提问|A 的回答');
check('A 写入后 B 的对话没被串掉', texts(await chatB.loadMessages()) === 'B 的提问');

/* ---------- 会话键：按标签页而不是地址 ---------- */

const keyA = chatA.conversationKey();
const keyB = chatB.conversationKey();
check('会话键带标签页前缀', keyA.startsWith('tab:'), keyA);
check('会话键不再包含页面地址', !keyA.includes('pintia.cn') && !keyA.includes('/problem-sets/'), keyA);
check('同 URL 的两个标签页会话键不同', keyA !== keyB, { keyA, keyB });

/* ---------- 刷新同一个标签页：恢复自己的那份 ---------- */

globalThis.sessionStorage = storageA;
const panelAReloaded = await loadPanel('tab=a-reload');
const chatAReloaded = await loadChat('tab=a-reload');
await panelAReloaded.initState();

check('刷新后 A 的草稿恢复', panelAReloaded.getDraft() === 'A 的草稿：同一道题', panelAReloaded.getDraft());
check('刷新后 A 的会话键不变', chatAReloaded.conversationKey() === keyA, {
  before: keyA,
  after: chatAReloaded.conversationKey(),
});

const restoredA = await chatAReloaded.loadMessages();
check('刷新后 A 的对话恢复', texts(restoredA) === 'A 的提问|A 的回答');
check('恢复时流式标记被清掉', restoredA.every((item) => item.streaming === false), restoredA);
check(
  '刷新后赶题模式的 run 桶还能接回去',
  texts(await chatAReloaded.loadMessages(chatAReloaded.runConversationKey('req-A'))) === '赶题中的提问',
);

// 刷新 B：仍然是 B 自己那份，不会捡到 A 的
globalThis.sessionStorage = storageB;
const panelBReloaded = await loadPanel('tab=b-reload');
const chatBReloaded = await loadChat('tab=b-reload');

check('刷新后 B 的草稿还是自己的', panelBReloaded.getDraft() === 'B 的草稿：另一份', panelBReloaded.getDraft());
check('刷新后 B 的对话还是自己的', texts(await chatBReloaded.loadMessages()) === 'B 的提问');

/* ---------- 清空草稿 / 清空对话 ---------- */

panelAReloaded.setDraft('');
check('清空后草稿是空的', panelAReloaded.getDraft() === '');
await chatAReloaded.clearMessages();
check('清空后对话是空的', (await chatAReloaded.loadMessages()).length === 0);
check(
  '清空主对话不影响赶题桶',
  texts(await chatAReloaded.loadMessages(chatAReloaded.runConversationKey('req-A'))) === '赶题中的提问',
);

console.log('\n标签页级存储通过');
