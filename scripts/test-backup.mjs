// 设置备份的编解码单测：纯逻辑，Node 剥掉类型后直接导入 .ts。
// 用法：node scripts/test-backup.mjs
import { decodeSettingsBackup, encodeSettingsBackup } from '../src/shared/backup.ts';
import { DEFAULT_SETTINGS } from '../src/shared/settings.ts';

const check = (label, ok, detail) => {
  if (!ok) {
    const extra = detail === undefined ? '' : `（实际：${JSON.stringify(detail).slice(0, 300)}）`;
    throw new Error(`✗ ${label}${extra}`);
  }
  console.log(`✓ ${label}`);
};

const sample = {
  ...DEFAULT_SETTINGS,
  apiKey: 'sk-test-123',
  baseURL: 'https://api.example.com/v1',
  model: 'test-model',
  theme: 'green',
  hyphenate: true,
};

// ---- 1. 编码 ----
const hex = encodeSettingsBackup(sample);
check('编码结果只含小写十六进制', /^[0-9a-f]+$/.test(hex), hex.slice(0, 40));
check('编码结果长度是偶数', hex.length % 2 === 0, hex.length);
check('编码结果里没有花括号与引号（抄进聊天框不会被转义）', !/[{}":]/.test(hex));

// ---- 2. 往返 ----
const decoded = decodeSettingsBackup(hex);
check('解码能还原回同一个对象', JSON.stringify(decoded) === JSON.stringify(sample), decoded);
check('还原出来的 Key 与主题都对', decoded?.apiKey === 'sk-test-123' && decoded?.theme === 'green');

// ---- 3. 非法输入 ----
check('空串返回 null', decodeSettingsBackup('') === null);
check('只有空白返回 null', decodeSettingsBackup('   ') === null);
check('奇数长度返回 null', decodeSettingsBackup('123') === null);
check('含非十六进制字符返回 null', decodeSettingsBackup('zz') === null);
check('合法 hex 但不是 JSON 返回 null', decodeSettingsBackup('7b7b7b') === null);

// 合法 JSON 但缺关键键：不能拿它覆盖现有设置
const missingKeys = Array.from(new TextEncoder().encode('{"theme":"red"}'))
  .map((byte) => byte.toString(16).padStart(2, '0'))
  .join('');
check('缺少 apiKey/baseURL/model 时返回 null', decodeSettingsBackup(missingKeys) === null);

// ---- 4. 旧备份补默认值 ----
// 只有必填三项的旧备份：还原后新字段应该是默认值，而不是 undefined
const legacyJson = JSON.stringify({ apiKey: 'k', baseURL: 'https://x/v1', model: 'm' });
const legacyHex = Array.from(new TextEncoder().encode(legacyJson))
  .map((byte) => byte.toString(16).padStart(2, '0'))
  .join('');
const legacy = decodeSettingsBackup(legacyHex);
check('旧备份能还原', legacy !== null);
check('旧备份缺的新字段落到默认值', legacy?.theme === DEFAULT_SETTINGS.theme && legacy?.providers.length === 0);

console.log('\n全部通过');
