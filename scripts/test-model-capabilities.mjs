// 视觉输入与 Qwen filesJson 兼容：纯函数，Node 剥类型后直接导入 .ts。
// 用法：node scripts/test-model-capabilities.mjs
const {
  decideVisionMode,
  extractImageUrls,
  modelSupportsVision,
  modelVisionTitle,
  visionUserMessage,
} = await import('../src/shared/model-capabilities.ts');
const { modelSupportsVlm, statementHasImages } = await import('../src/shared/settings.ts');
const { TOOL_SCHEMAS, normalizeToolArguments, parseToolArguments } = await import('../src/shared/tools.ts');

const check = (label, ok, detail) => {
  if (!ok) {
    const extra = detail === undefined ? '' : `（实际：${JSON.stringify(detail).slice(0, 400)}）`;
    throw new Error(`✗ ${label}${extra}`);
  }
  console.log(`✓ ${label}`);
};

// ---- 1. 能力表：Qwen3.8-27B 支持视觉，DeepSeek-V4.1-Flash 明确不支持 ----
check('Qwen/Qwen3.8-27B 判定为支持视觉', modelSupportsVision('Qwen/Qwen3.8-27B') === true);
check('Qwen3.8-27B（无厂商前缀）也支持视觉', modelSupportsVision('Qwen3.8-27B-Instruct') === true);
check('deepseek-ai/DeepSeek-V4.1-Flash 判定为纯文本', modelSupportsVision('deepseek-ai/DeepSeek-V4.1-Flash') === false);
check('未知模型按不支持处理', modelSupportsVision('some-unknown-model') === false);
check('qwen-vl 家族仍然支持视觉', modelSupportsVision('Qwen/Qwen2.5-VL-72B') === true);
check('老的 modelSupportsVlm 入口与能力表一致', modelSupportsVlm('Qwen/Qwen3.8-27B') === true);

// ---- 2. 设置页 eye icon 的判定逻辑（下拉里按这个函数决定显不显示） ----
const models = ['Qwen/Qwen3.8-27B', 'deepseek-ai/DeepSeek-V4.1-Flash', 'Qwen/Qwen2.5-VL-72B'];
const withEye = models.filter((id) => modelSupportsVision(id));
check(
  '模型下拉只给支持视觉的模型挂 eye icon',
  JSON.stringify(withEye) === JSON.stringify(['Qwen/Qwen3.8-27B', 'Qwen/Qwen2.5-VL-72B']),
  withEye,
);
check('Qwen 的 tooltip 写明支持看图', /支持看图/.test(modelVisionTitle('Qwen/Qwen3.8-27B')));
check('DeepSeek 的 tooltip 写明纯文本', /纯文本/.test(modelVisionTitle('deepseek-ai/DeepSeek-V4.1-Flash')));

// ---- 3. vlmMode 语义：off 时就算模型能看图也不激活 ----
check(
  'vlmMode=off + 有图 + 支持视觉的模型 → off（不激活）',
  decideVisionMode({ mode: 'off', model: 'Qwen/Qwen3.8-27B', hasImages: true }) === 'off',
);
check(
  'vlmMode=off + 有图 + 不支持视觉的模型 → 仍是 off',
  decideVisionMode({ mode: 'off', model: 'deepseek-ai/DeepSeek-V4.1-Flash', hasImages: true }) === 'off',
);
check(
  'vlmMode=auto + 有图 + Qwen → active',
  decideVisionMode({ mode: 'auto', model: 'Qwen/Qwen3.8-27B', hasImages: true }) === 'active',
);
check(
  'vlmMode=on + 有图 + Qwen → active',
  decideVisionMode({ mode: 'on', model: 'Qwen/Qwen3.8-27B', hasImages: true }) === 'active',
);
check(
  'vlmMode=auto + 有图 + DeepSeek → unsupported-model（明确降级）',
  decideVisionMode({ mode: 'auto', model: 'deepseek-ai/DeepSeek-V4.1-Flash', hasImages: true })
    === 'unsupported-model',
);
check(
  '题面没图时不会凭空激活视觉模式',
  decideVisionMode({ mode: 'on', model: 'Qwen/Qwen3.8-27B', hasImages: false }) === 'no-images',
);
check('statementHasImages 识别 read_problem 的图片占位', statementHasImages('题干 [图片：a.jpg <https://x/a.jpg>]'));
check('普通题面不算有图', statementHasImages('输入两个整数，输出它们的和') === false);

// ---- 4. 从题面占位构造真正的 image_url 内容块 ----
const pageUrl = 'https://pintia.cn/problem-sets/1/exam/problems/type/7?problemSetProblemId=2';
const statement = [
  '题面 [图片（476×174）：if编程.jpg <https://images.ptausercontent.com/a.jpg>]',
  '[图片：示意图 <images/b.png>]',
  '[图片：内嵌 <data:image/png>]',
  '[图片：重复 <https://images.ptausercontent.com/a.jpg>]',
].join('\n');
const extracted = extractImageUrls(statement, pageUrl);
check(
  '提取绝对图片地址 + 补全相对地址 + 去重',
  extracted.urls.length === 2
    && extracted.urls[0] === 'https://images.ptausercontent.com/a.jpg'
    && extracted.urls[1] === new URL('images/b.png', pageUrl).href,
  extracted.urls,
);
check('内嵌 data: 图片没有可发送地址，计入 skipped', extracted.skipped === 1, extracted);
const protocolRelative = extractImageUrls('[图片：x <//cdn.example.com/a.png>]');
check(
  '协议相对地址能补成 https',
  protocolRelative.urls.length === 1 && protocolRelative.urls[0] === 'https://cdn.example.com/a.png',
  protocolRelative,
);

const visionMessage = visionUserMessage('请看题面图片', extracted.urls);
check('视觉消息是 user 角色', visionMessage.role === 'user');
check('视觉消息 content 是内容块数组', Array.isArray(visionMessage.content));
check(
  '视觉消息第一个块是说明文字',
  visionMessage.content[0]?.type === 'text' && visionMessage.content[0].text === '请看题面图片',
  visionMessage.content[0],
);
check(
  '视觉消息带 OpenAI 兼容的 image_url 块',
  visionMessage.content[1]?.type === 'image_url'
    && visionMessage.content[1].image_url.url === 'https://images.ptausercontent.com/a.jpg'
    && visionMessage.content[2]?.type === 'image_url',
  visionMessage.content,
);
check(
  '整条消息序列化后就是接口要的形状',
  JSON.parse(JSON.stringify(visionMessage)).content[1].type === 'image_url',
);

// ---- 5. Qwen 把 write_zip.files 清成 {} 时的 filesJson 兼容 ----
const files = { 'src/a.py': 'print(1)', 'main.sh': 'echo hi' };
const zipArgs = JSON.stringify({
  filename: '实验13-1.zip',
  files: {},
  filesJson: JSON.stringify(files),
});
const zipParsed = parseToolArguments(zipArgs, 'write_zip');
check('files={} + filesJson：解析成真正的 files', zipParsed.ok === true
  && JSON.stringify(zipParsed.args.files) === JSON.stringify(files), zipParsed);
check('filesJson 不再往下传给页面工具', zipParsed.ok === true && !('filesJson' in zipParsed.args));

const doubleEncoded = parseToolArguments(
  JSON.stringify({ filename: 'a.zip', filesJson: JSON.stringify(JSON.stringify(files)) }),
  'write_zip',
);
check('filesJson 被多包了一层字符串也能解析', doubleEncoded.ok === true
  && JSON.stringify(doubleEncoded.args.files) === JSON.stringify(files), doubleEncoded);

const objectJson = normalizeToolArguments('write_zip', { filename: 'a.zip', filesJson: files });
check('filesJson 直接给对象也接受', objectJson.ok === true
  && JSON.stringify(objectJson.args.files) === JSON.stringify(files), objectJson);

const emptyFiles = parseToolArguments(JSON.stringify({ filename: 'a.zip', files: {} }), 'write_zip');
check('files 空对象且没有 filesJson：明确报错，不生成空 zip', emptyFiles.ok === false
  && /filesJson/.test(emptyFiles.error) && /空对象/.test(emptyFiles.error), emptyFiles);

const emptyArgs = parseToolArguments('', 'write_zip');
check('write_zip 一个参数都没给也提示 filesJson', emptyArgs.ok === false && /filesJson/.test(emptyArgs.error), emptyArgs);

const brokenJson = parseToolArguments(
  JSON.stringify({ filename: 'a.zip', files: {}, filesJson: '{oops' }),
  'write_zip',
);
check('filesJson 不是合法 JSON 时给出原因', brokenJson.ok === false && /不是合法 JSON/.test(brokenJson.error), brokenJson);

const nonStringValue = parseToolArguments(
  JSON.stringify({ filename: 'a.zip', filesJson: '{"a.py": 1}' }),
  'write_zip',
);
check('filesJson 里的文件内容不是字符串时报错', nonStringValue.ok === false && /必须是字符串/.test(nonStringValue.error), nonStringValue);

const arrayJson = parseToolArguments(
  JSON.stringify({ filename: 'a.zip', filesJson: '["a.py"]' }),
  'write_zip',
);
check('filesJson 解析成数组时报错', arrayJson.ok === false && /必须是对象/.test(arrayJson.error), arrayJson);

const normalFiles = parseToolArguments(JSON.stringify({ filename: 'a.zip', files }), 'write_zip');
check('files 正常时保持原样', normalFiles.ok === true
  && JSON.stringify(normalFiles.args.files) === JSON.stringify(files), normalFiles);

// write_document：单文件用 content；多文件用 files/filesJson
const docSingle = parseToolArguments(
  JSON.stringify({ filename: '题解.md', content: '正文', files: {} }),
  'write_document',
);
check('write_document 单文件 + 空 files：仍按 content 写文件', docSingle.ok === true
  && docSingle.args.content === '正文' && !('files' in docSingle.args), docSingle);

const docJson = parseToolArguments(
  JSON.stringify({ filename: 'answer.zip', files: {}, filesJson: JSON.stringify(files) }),
  'write_document',
);
check('write_document 也能用 filesJson 打 zip', docJson.ok === true
  && JSON.stringify(docJson.args.files) === JSON.stringify(files), docJson);

const docEmpty = parseToolArguments(JSON.stringify({ filename: 'a.zip', files: {} }), 'write_document');
check('write_document 既没 content 也没 files/filesJson 时报错', docEmpty.ok === false
  && /filesJson/.test(docEmpty.error), docEmpty);

const docEmptyArgs = parseToolArguments('', 'write_document');
check('write_document 空参数给出明确错误', docEmptyArgs.ok === false && /content/.test(docEmptyArgs.error), docEmptyArgs);

// 别的工具不受兼容层影响
const dateArgs = parseToolArguments(JSON.stringify({}), 'date');
check('其它工具的参数解析保持原样', dateArgs.ok === true && JSON.stringify(dateArgs.args) === '{}');

// ---- 6. schema 已经告诉模型 filesJson 的存在 ----
const zipSchema = TOOL_SCHEMAS.find((item) => item.function.name === 'write_zip');
const docSchema = TOOL_SCHEMAS.find((item) => item.function.name === 'write_document');
check('write_zip schema 带 filesJson', Boolean(zipSchema?.function.parameters.properties.filesJson));
check(
  'write_zip 不再强制 files（允许 filesJson 代替）',
  Array.isArray(zipSchema?.function.parameters.required)
    && !zipSchema.function.parameters.required.includes('files'),
);
check('write_document schema 带 filesJson', Boolean(docSchema?.function.parameters.properties.filesJson));
check(
  'write_zip 的描述提醒 files 可能被清空',
  /filesJson/.test(zipSchema?.function.description ?? ''),
);

console.log('\n全部通过');
