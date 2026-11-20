// 设置备份的「魔数」编解码。
//
// 用户把设置页导出的一串十六进制抄走，换台电脑粘进欢迎页就能把 Key、接口地址、
// 模型与全部开关搬过去，不用一个个手填。
//
// 为什么是 hex 而不是直接给 JSON：JSON 里有引号、花括号、换行，抄进聊天框/记事本
// 很容易被自动转义或折行弄坏；纯 [0-9a-f] 怎么复制都不会变。
//
// 这里不碰任何浏览器 API（不 import chrome 包装），scripts/test-backup.mjs
// 可以让 Node 剥掉类型后直接导入做单测。

import { DEFAULT_SETTINGS, type Settings } from './settings.ts';

/** 备份里必须有的键：缺了说明这串东西不是设置备份（或是更早的其它格式） */
const REQUIRED_KEYS = ['apiKey', 'baseURL', 'model'] as const;

function toHex(bytes: Uint8Array): string {
  let text = '';
  for (const byte of bytes) text += byte.toString(16).padStart(2, '0');
  return text;
}

/**
 * 把设置编成一串小写十六进制。
 *
 * 注意导出的是**完整设置**（含 apiKey）：用户点「导出」就是要搬走 Key，
 * 页面上的提示也写明了这一点。
 */
export function encodeSettingsBackup(settings: Settings): string {
  return toHex(new TextEncoder().encode(JSON.stringify(settings)));
}

/**
 * 把备份串还原成设置。
 *
 * 任何一步不对（空串、奇数长度、含非法字符、不是 JSON、不是对象、缺关键键）
 * 都返回 null：宁可让用户重抄一遍，也不要拿半份配置去覆盖现有设置。
 */
export function decodeSettingsBackup(hex: string): Settings | null {
  const text = (hex ?? '').trim();
  if (!text) return null;
  if (!/^[0-9a-f]+$/i.test(text)) return null;
  if (text.length % 2 !== 0) return null;

  const bytes = new Uint8Array(text.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(text.slice(index * 2, index * 2 + 2), 16);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;

  const record = parsed as Record<string, unknown>;
  for (const key of REQUIRED_KEYS) {
    if (!(key in record)) return null;
  }
  // 旧备份里没有后来新增的字段：缺的那些落到默认值，别让界面读到 undefined
  return { ...DEFAULT_SETTINGS, ...record } as Settings;
}
