// 护栏判定：授权识别、ask 硬门、正文选项解析。
// 用法：node scripts/test-guardrails.mjs
import {
  choiceDeniesSubmit,
  choiceDeniesWrite,
  parseOptionQuestion,
  submitGuardReason,
  userAskedToSubmit,
  userAskedToWrite,
  writeGuardReason,
} from '../src/shared/guardrails.ts';

const check = (label, ok, detail) => {
  if (!ok) {
    const extra = detail === undefined ? '' : `（实际：${JSON.stringify(detail).slice(0, 300)}）`;
    throw new Error(`✗ ${label}${extra}`);
  }
  console.log(`✓ ${label}`);
};

/* ---------- 授权识别 ---------- */

check('「帮我改一下代码」算明确要求改', userAskedToWrite('帮我改一下代码'));
check('「帮我写代码」算明确要求写', userAskedToWrite('帮我写代码'));
check('「这道题怎么写」不算改代码授权', !userAskedToWrite('这道题怎么写'));
check('「帮我看看哪里错了」不算改代码授权', !userAskedToWrite('帮我看看哪里错了'));
check('「不要改代码」不算授权', !userAskedToWrite('不要改代码'));
check('「先别改，只讲思路」不算授权', !userAskedToWrite('先别改，只讲思路'));

check('「提交吧」算明确要求提交', userAskedToSubmit('提交吧'));
check('「帮我交上去」算明确要求提交', userAskedToSubmit('帮我交上去'));
check('「先别提交」不算提交授权', !userAskedToSubmit('先别提交'));
check('「继续改」不算提交授权', !userAskedToSubmit('继续改'));

check('ask 回答「先别改」会被识别为拒绝改代码', choiceDeniesWrite('先别改，只讲思路'));
check('ask 回答「改」不会被当成拒绝', !choiceDeniesWrite('改'));
check('ask 回答「先不提交」会被识别为拒绝提交', choiceDeniesSubmit('先不提交'));
check('ask 回答「提交」不会被当成拒绝提交', !choiceDeniesSubmit('提交'));

/* ---------- 工具硬门 ---------- */

check(
  '没问过、用户也没要求改：write_editor_code 必须被拦',
  writeGuardReason({ askUsed: false, denied: false, lastUserText: '这道题怎么写' })?.includes('未先询问'),
);
check(
  '用户本条明确要求改：放行 write_editor_code',
  writeGuardReason({ askUsed: false, denied: false, lastUserText: '帮我改一下代码' }) === null,
);
check(
  '已经 ask 过：放行 write_editor_code',
  writeGuardReason({ askUsed: true, denied: false, lastUserText: '' }) === null,
);
check(
  '用户刚选了先别改：即使 ask 过也拦住',
  Boolean(writeGuardReason({ askUsed: true, denied: true, lastUserText: '帮我改一下代码' })),
);
check(
  '没问过：submit_answer 必须被拦',
  submitGuardReason({ askUsed: false, denied: false, lastUserText: '继续' })?.includes('提交前必须'),
);
check(
  '用户本条明确要求提交：放行 submit_answer',
  submitGuardReason({ askUsed: false, denied: false, lastUserText: '提交吧' }) === null,
);
check(
  '用户刚选了先不提交：拦住 submit_answer',
  Boolean(submitGuardReason({ askUsed: true, denied: true, lastUserText: '提交吧' })),
);

/* ---------- 正文选项解析 ---------- */

const numbered = parseOptionQuestion('需要我帮你提交吗？\n1. 提交\n2. 先不提交');
check('识别编号列表选项', numbered?.question === '需要我帮你提交吗？');
check('编号选项内容正确', JSON.stringify(numbered?.options) === JSON.stringify(['提交', '先不提交']));

const bullet = parseOptionQuestion('要修改吗？\n- 改\n- 先别改，只讲思路');
check('识别 - 列表选项', JSON.stringify(bullet?.options) === JSON.stringify(['改', '先别改，只讲思路']));

const letters = parseOptionQuestion('这道题有两种做法，你选哪个？\nA. 暴力枚举\nB. 二分查找');
check('识别 A./B. 选项', JSON.stringify(letters?.options) === JSON.stringify(['暴力枚举', '二分查找']));

const inline = parseOptionQuestion('需要我帮你提交吗？');
check('是/否问题按关键词给选项', JSON.stringify(inline?.options) === JSON.stringify(['提交', '先不提交']));

const either = parseOptionQuestion('你想用 Python 还是 C++ 来做？');
check('识别「A 还是 B」', JSON.stringify(either?.options) === JSON.stringify(['Python', 'C++']));

check('普通疑问句不转 ask', parseOptionQuestion('为什么这里会 WA？') === null);
check('没有选项也没有提示词的句子不转 ask', parseOptionQuestion('通过率 60%，这题怎么做？') === null);
check('只有列表没有提问不转 ask', parseOptionQuestion('总结：\n1. 先读题\n2. 再写代码') === null);
check('单选项不转 ask', parseOptionQuestion('要提交吗？\n1. 提交') === null);

console.log('\n护栏判定校验通过');
