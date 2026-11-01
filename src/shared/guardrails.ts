// 护栏的纯判定逻辑：能不能不问就改代码/提交、正文里的选择题要不要转成 ask。
//
// 放在 shared 是为了脱离浏览器单测（scripts/test-guardrails.mjs）；
// agent loop 只负责在这些判定为「需要询问」时拦下工具调用或合成 ask 卡片。

export interface OptionQuestion {
  question: string;
  options: string[];
}

/** 列表项：- / * / 1. / A. / ① 开头 */
const LIST_ITEM = /^\s*(?:[-*•·]|\d{1,2}[.、)]|[A-Da-d][.、)]|[①②③④])\s*(.+)$/;

/** 像「在征求用户选择」的句式 */
const CHOICE_HINT = /(要不要|需要我|需要帮你|是否需要|是否要|要我|帮你|为你|可以吗|好吗|行吗|选哪个|哪一种|哪个方案|还是)/;

/** 用户本条明确要求改代码 */
const WRITE_REQUEST =
  /(帮我|帮忙|请|麻烦|直接|给我|把).{0,16}(改|修改|重写|补全|实现|优化|换成|调整|写(?:个|一个)?(?:代码|程序|解法)|写进作答区)|(改一下|改下|修改一下|修改代码|重写代码|补全代码|实现一下|优化一下|写进作答区|写进代码框)|^(改|修改|重写|补全|实现|优化|换成)/;

/** 用户明确说不要改 */
const WRITE_DENY = /(不要改|别改|先别改|不要动|先别动|不要写|别写|只讲|只解释|不要修|别修|不用改)/;

/** 用户本条明确要求提交 */
const SUBMIT_REQUEST = /(提交|交一下|交上去|提交答案|submit)/i;
const SUBMIT_DENY = /(先别提交|不要提交|别提交|不用提交|不提交)/;

/** ask 卡片上的回答是不是「不要改 / 只讲思路」 */
export function choiceDeniesWrite(choice: string): boolean {
  return /(先别改|别改|不要改|不用改|不改|只讲|只解释|不要动|先别动|不要写)/.test(choice);
}

/** ask 卡片上的回答是不是「先不提交」 */
export function choiceDeniesSubmit(choice: string): boolean {
  return /(先别提交|别提交|不要提交|不用提交|不提交)/.test(choice);
}

/** 用户本条消息是否明确要求改/写代码 */
export function userAskedToWrite(text: string): boolean {
  return !WRITE_DENY.test(text) && WRITE_REQUEST.test(text);
}

/** 用户本条消息是否明确要求提交 */
export function userAskedToSubmit(text: string): boolean {
  return !SUBMIT_DENY.test(text) && SUBMIT_REQUEST.test(text);
}

/** write_editor_code 是否必须先 ask；返回 null 表示放行 */
export function writeGuardReason(state: {
  askUsed: boolean;
  denied: boolean;
  lastUserText: string;
}): string | null {
  if (state.denied) {
    return '用户刚才选择了「先别改」，这一轮不要再改作答区；用文字讲思路，等用户下一次明确要求。';
  }
  if (state.askUsed || userAskedToWrite(state.lastUserText)) return null;
  return '⛔ 未先询问：改作答区代码前必须调用 ask 工具（question + 2–4 个互斥选项，例如「要不要我直接改作答区？」）。'
    + '先问，拿到用户回答后再重试 write_editor_code。';
}

/** submit_answer 是否必须先 ask；返回 null 表示放行 */
export function submitGuardReason(state: {
  askUsed: boolean;
  denied: boolean;
  lastUserText: string;
}): string | null {
  if (state.denied) {
    return '用户刚才选择了「先不提交」，这一轮不要再提交。';
  }
  if (state.askUsed || userAskedToSubmit(state.lastUserText)) return null;
  return '⛔ 未先询问：提交前必须调用 ask 工具确认（例如「要我提交吗？」选项「提交 / 先不提交」）。'
    + '先问，拿到用户回答后再重试 submit_answer。';
}

function cleanLine(line: string): string {
  return line
    .replace(/^[\s"'“”‘’`]+|[\s"'“”‘’`]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function isQuestionLine(line: string): boolean {
  return /[？?]\s*$/.test(line) || /(吗|呢)\s*[。.!！]?\s*$/.test(line) || CHOICE_HINT.test(line);
}

/** 是/否型问题按关键词给一对更具体的选项，避免「要 / 不要」太含糊 */
function yesNoOptions(question: string): string[] {
  if (/(提交|交上去|交一下)/.test(question)) return ['提交', '先不提交'];
  if (/(改|修改|重写|修复)/.test(question)) return ['改', '先别改，只讲思路'];
  if (/继续/.test(question)) return ['继续', '先停'];
  if (/(运行|测试)/.test(question)) return ['运行', '先不运行'];
  return ['要', '不要'];
}

/**
 * 从最终回答里识别「需要用户拍板、且能列成选项」的问题。
 * 识别不到就返回 null（宁可漏转，也不要把普通疑问句硬塞进 ask）。
 */
export function parseOptionQuestion(text: string): OptionQuestion | null {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return null;

  let questionIndex = -1;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (isQuestionLine(lines[index])) {
      questionIndex = index;
      break;
    }
  }
  if (questionIndex < 0) return null;

  const question = cleanLine(lines[questionIndex]);
  if (!question || question.length > 200) return null;

  // 一、问题之后紧跟的列表项就是选项
  const options: string[] = [];
  for (let index = questionIndex + 1; index < lines.length; index += 1) {
    const match = lines[index].match(LIST_ITEM);
    if (!match) continue;
    const option = cleanLine(match[1]).replace(/[。；;，,]+$/g, '');
    if (option && option.length <= 30) options.push(option);
  }

  // 二、没有列表：看「A 还是 B」
  if (options.length < 2) {
    const parts = question.split('还是');
    if (parts.length === 2) {
      const left = cleanLine(
        parts[0]
          .replace(/^.*?[，,：:]\s*/, '')
          .replace(/^(你想用|你想|想用|选择|选|要用|用|要|是)\s*/, ''),
      );
      const right = cleanLine(
        parts[1]
          .replace(/[？?。！!].*$/, '')
          .replace(/(来做|做|呢|吧)\s*$/, ''),
      );
      if (left && right && left.length <= 20 && right.length <= 20) options.push(left, right);
    }
  }

  // 三、还是没有：是/否问题按关键词给一对选项
  if (options.length < 2 && CHOICE_HINT.test(question)) options.push(...yesNoOptions(question));

  const unique = [...new Set(options.map((option) => option.trim()).filter(Boolean))].slice(0, 4);
  if (unique.length < 2) return null;

  return { question, options: unique };
}
