// 上下文长度查找的纯逻辑校验：精确值/估算值的选择、模型列表里挑字段、models.dev 匹配。
// 用法：node scripts/test-context.mjs
import {
  extractContextWindowFromModels,
  extractContextWindowFromModelsDev,
} from '../src/shared/model-context.ts';
import { DEFAULT_CONTEXT_WINDOW, contextWindowFor, pickContextWindow } from '../src/shared/settings.ts';

const check = (label, ok) => {
  if (!ok) throw new Error(`✗ ${label}`);
  console.log(`✓ ${label}`);
};

/* ---------- pickContextWindow：精确值优先，查不到才估算 ---------- */

const withExact = pickContextWindow('deepseek-chat', 200_000);
check('给了精确值就用精确值', withExact.window === 200_000 && withExact.exact === true);

const withoutExact = pickContextWindow('claude-3-5-sonnet');
check(
  '不给精确值就用估算表（claude → 200K）',
  withoutExact.window === 200_000 && withoutExact.exact === false,
);

check(
  '估算表取的值和 contextWindowFor 一致',
  pickContextWindow('gemini-2.5-pro').window === contextWindowFor('gemini-2.5-pro') &&
    pickContextWindow('gemini-2.5-pro').exact === false,
);

const emptyModel = pickContextWindow('');
check(
  '空模型名返回兜底值',
  emptyModel.window === DEFAULT_CONTEXT_WINDOW && emptyModel.exact === false,
);

check('精确值为 0 时不当成有效值', pickContextWindow('gpt-4o', 0).exact === false);
check('精确值为 undefined 时不当成有效值', pickContextWindow('gpt-4o', undefined).exact === false);
check('精确值为 null 时不当成有效值', pickContextWindow('gpt-4o', null).exact === false);

/* ---------- 从模型列表里挑上下文字段 ---------- */

check(
  'context_length 字段能被认出来',
  extractContextWindowFromModels([{ id: 'deepseek-chat', context_length: 128_000 }], 'deepseek-chat') ===
    128_000,
);

check(
  '{ data: [...] } 这种返回也能认出来',
  extractContextWindowFromModels({ data: [{ id: 'deepseek-chat', context_length: 64_000 }] }, 'deepseek-chat') ===
    64_000,
);

check(
  '模型名带厂商前缀时也能对上（列表里是 deepseek-chat）',
  extractContextWindowFromModels(
    [{ id: 'deepseek-chat', context_length: 128_000 }],
    'deepseek/deepseek-chat',
  ) === 128_000,
);

check(
  '模型名带厂商前缀时也能对上（列表里是 deepseek/deepseek-chat）',
  extractContextWindowFromModels(
    [{ id: 'deepseek/deepseek-chat', context_length: 128_000 }],
    'deepseek-chat',
  ) === 128_000,
);

check(
  '多个候选字段时取优先级最高的那个',
  extractContextWindowFromModels(
    [{ id: 'm', max_input_tokens: 4096, context_length: 200_000 }],
    'm',
  ) === 200_000,
);

check(
  '字段名大小写不敏感',
  extractContextWindowFromModels([{ id: 'm', Context_Length: 32_000 }], 'm') === 32_000,
);

check(
  '字段藏在一层嵌套里也能认出来',
  extractContextWindowFromModels([{ id: 'm', limits: { context_window: 262_144 } }], 'm') === 262_144,
);

check(
  '条目里没有上下文字段时返回 null',
  extractContextWindowFromModels([{ id: 'm', owned_by: 'acme' }], 'm') === null,
);

check(
  '列表里没有这个模型时返回 null',
  extractContextWindowFromModels([{ id: 'other', context_length: 128_000 }], 'm') === null,
);

check(
  '包含匹配命中多条时不敢用，返回 null',
  extractContextWindowFromModels(
    [
      { id: 'm-1', context_length: 128_000 },
      { id: 'm-2', context_length: 256_000 },
    ],
    'm',
  ) === null,
);

check(
  '字段值不是正数时不认',
  extractContextWindowFromModels([{ id: 'm', context_length: 0 }], 'm') === null,
);

/* ---------- models.dev 数据集 ---------- */

const modelsDev = {
  'anthropic/claude-3-5-sonnet': { limit: { context: 200_000, output: 8192 } },
  'deepseek/deepseek-chat': { limit: { context: 128_000, output: 8192 } },
};

check(
  'models.dev 里键精确相等能对上',
  extractContextWindowFromModelsDev(modelsDev, 'anthropic/claude-3-5-sonnet') === 200_000,
);

check(
  'models.dev 里键的末段等于模型名能对上',
  extractContextWindowFromModelsDev(modelsDev, 'claude-3-5-sonnet') === 200_000,
);

check(
  'models.dev 里带厂商前缀的模型名能对上',
  extractContextWindowFromModelsDev(modelsDev, 'deepseek/deepseek-chat') === 128_000,
);

check(
  'models.dev 里查不到时返回 null',
  extractContextWindowFromModelsDev(modelsDev, 'some-unknown-model') === null,
);
