// 内置运行器的 Worker 侧。
//
// 两套引擎：
//   - C/C++：clang + lld + sysroot 都是本地 wasm 资源，串行处理「编译 + 运行」请求
//   - Python：本地 Pyodide（public/engine/pyodide/ 下的资源），直接解释执行
//
// 超时终止由宿主负责（worker.terminate 整个杀掉，死循环只有这样才能停下来）。
//
// 协议（postMessage）：
//   收 { id, code, stdin, lang } 或 { id, code, lang, check: true }
//      （check: true = 只做静态检查，不链接不运行；C/C++ 走 -fsyntax-only，Python 走 compile() + AST）
//   回 { id, type: 'stage', stage }   阶段推进（compile / check / run），宿主据此重置超时
//      { id, type: 'done', result }   结构化结果（含编译错误 / 运行结果 / 引擎错误）

import { createCEngine, runOnEngine, checkOnEngine, MAX_RUNS_PER_ENGINE } from './engine-core.js';
import { makeStdinReader } from './worker-utils.js';

let engine = null;
let enginePromise = null;

async function readBuffer(name) {
  const response = await fetch(new URL(name, self.location.href));
  if (!response.ok) {
    throw new Error(`加载编译器资源 ${name} 失败（HTTP ${response.status}）`);
  }
  return response.arrayBuffer();
}

async function compileStreaming(name) {
  return WebAssembly.compile(await readBuffer(name));
}

function getEngine() {
  if (engine && engine.runs < MAX_RUNS_PER_ENGINE) return Promise.resolve(engine);
  engine = null;
  if (!enginePromise) {
    enginePromise = (async () => {
      const made = createCEngine({ readBuffer, compileStreaming });
      await made.api.ready; // 这里会把 38MB 的 sysroot 解进 memfs
      engine = made;
      return made;
    })().finally(() => { enginePromise = null; });
  }
  return enginePromise;
}

/* ---------- Python（Pyodide，本地资源） ---------- */

let pyodidePromise = null;

function getPyodide() {
  if (!pyodidePromise) {
    pyodidePromise = (async () => {
      // pyodide.mjs 是 ESM，动态 import 它；indexURL 指向本地目录，
      // 这样 wasm 与 python_stdlib.zip 都从扩展包里读，不联网
      const { loadPyodide } = await import('./pyodide/pyodide.mjs');
      return loadPyodide({ indexURL: new URL('./pyodide/', self.location.href).href });
    })().catch((error) => {
      pyodidePromise = null; // 下次重试
      throw error;
    });
  }
  return pyodidePromise;
}

async function runPython({ id, code, stdin }) {
  const started = Date.now();
  // Pyodide 首次加载要十几秒，这段时间算「加载」不算「运行」：
  // 混进运行预算里，第一次跑 Python 就会被误判成死循环
  postMessage({ id, type: 'stage', stage: 'prepare' });

  let stdout = '';
  let stderr = '';
  let error = null;

  try {
    const py = await getPyodide();
    postMessage({ id, type: 'stage', stage: 'run' });

    // Pyodide 的 stdin 要按行喂：input() 一次取一行；耗尽后必须返回 null 表示 EOF
    py.setStdin({ stdin: makeStdinReader(stdin) });

    const outChunks = [];
    const errChunks = [];
    py.setStdout({ batched: (text) => { outChunks.push(text); } });
    py.setStderr({ batched: (text) => { errChunks.push(text); } });

    await py.runPythonAsync(code);

    // Pyodide 的 stdout/stderr 是「按行批处理」的：最后一段没有换行（例如
    // print(..., end=" ")）不会触发 batched 回调，输出会整个丢掉。写一个换行
    // 把缓冲区冲出来，再把额外补的换行去掉。
    try {
      await py.runPythonAsync('import sys\nsys.stdout.write("\\n")\nsys.stderr.write("\\n")');
    } catch {
      // 用户代码如果把 stdout/stderr 关了，忽略这次补换行
    }

    stdout = outChunks.join('').replace(/\n$/, '');
    stderr = errChunks.join('').replace(/\n$/, '');
  } catch (e) {
    error = e && e.message ? e.message : String(e);
    // 异常信息往往在 stderr 里，模型要看到堆栈
    if (!stderr && error) stderr = error;
  }

  postMessage({
    id,
    type: 'done',
    result: {
      stage: error ? 'run-exit' : 'ok',
      stdout,
      stderr,
      compileOutput: '',
      exitCode: error ? 1 : 0,
      trap: null,
      message: error || '',
      elapsedMs: Date.now() - started,
    },
  });
}

/* ---------- Python 语法检查（compile + AST，不执行） ---------- */

let pythonCheckerReady = false;

/**
 * 在 Python 侧装一个只做「语法检查 + AST 未定义名字检查」的函数（绝不执行用户代码）。
 *
 * 与 src/background/compile.ts 的 PYTHON_CHECK_SCRIPT 是同一段逻辑：
 * Worker 里跑 Pyodide，Node 测试里跑 python3，两端必须给出同一种 JSON（诊断数组）
 * 和 `<pta>:行:列: 级别: 说明` 文本。改动时两边一起改。
 *
 * 为什么要 AST：`returnsentence` 这种没定义的名字语法完全合法，compile() 不会报，
 * 学生要等到运行时才看到 NameError。这里把 Name(Load) 和定义名对一遍。
 */
function ensurePythonChecker(py) {
  if (pythonCheckerReady) return;
  py.runPython(String.raw`
import ast
import builtins
import json as __pta_json
import re
import textwrap

# 片段（代码填空题）插进裁判程序后，题面/裁判提供的名字不在作答区里：
# 这类未定义名字按 warning 报，普通代码按 error 报。
__PTA_INDENT_ERROR = re.compile(
    r'unexpected indent|expected an indented block|unindent does not match|inconsistent use of tabs'
)
# 解释器/模块系统直接提供的 dunder 不算未定义名字
__PTA_EXTRA_NAMES = frozenset((
    '__name__', '__file__', '__doc__', '__package__', '__spec__', '__loader__',
    '__builtins__', '__annotations__', '__cached__', '__path__', '__all__',
    '__version__', '__debug__', '__class__', '__dict__', '__module__',
    '__qualname__', '__slots__', '__weakref__', '__metaclass__',
))
# match 语句的绑定名不是 ast.Name，得单独收集（这些节点 Python 3.10+ 才有）
__PTA_MATCH_BINDINGS = tuple(
    node for node in (
        getattr(ast, 'MatchAs', None),
        getattr(ast, 'MatchStar', None),
        getattr(ast, 'MatchMapping', None),
    ) if node is not None
)


def __pta_add_arguments(names, arguments):
    for arg in list(getattr(arguments, 'posonlyargs', [])) + list(arguments.args) + list(arguments.kwonlyargs):
        names.add(arg.arg)
    if arguments.vararg:
        names.add(arguments.vararg.arg)
    if arguments.kwarg:
        names.add(arguments.kwarg.arg)


def __pta_defined_names(tree):
    names = set(dir(builtins))
    names.update(__PTA_EXTRA_NAMES)
    star_import = False
    for node in ast.walk(tree):
        if isinstance(node, ast.Name):
            if isinstance(node.ctx, ast.Store):
                names.add(node.id)
        elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            names.add(node.name)
            __pta_add_arguments(names, node.args)
        elif isinstance(node, ast.Lambda):
            __pta_add_arguments(names, node.args)
        elif isinstance(node, ast.ClassDef):
            names.add(node.name)
        elif isinstance(node, ast.Import):
            for alias in node.names:
                names.add(alias.asname or alias.name.split('.')[0])
        elif isinstance(node, ast.ImportFrom):
            for alias in node.names:
                if alias.name == '*':
                    star_import = True
                else:
                    names.add(alias.asname or alias.name)
        elif isinstance(node, ast.ExceptHandler):
            if node.name:
                names.add(node.name)
        elif isinstance(node, (ast.Global, ast.Nonlocal)):
            names.update(node.names)
        elif __PTA_MATCH_BINDINGS and isinstance(node, __PTA_MATCH_BINDINGS):
            for attribute in ('name', 'rest'):
                bound = getattr(node, attribute, None)
                if bound:
                    names.add(bound)
    return names, star_import


def __pta_undefined_names(tree, fragment):
    names, star_import = __pta_defined_names(tree)
    # from x import * 会带进未知名字：任何「未定义」判断都可能误报，整段跳过
    if star_import:
        return []
    first = {}
    for node in ast.walk(tree):
        if not isinstance(node, ast.Name) or not isinstance(node.ctx, ast.Load):
            continue
        if node.id in names:
            continue
        position = (node.lineno, node.col_offset)
        if node.id not in first or position < first[node.id]:
            first[node.id] = position
    severity = 'warning' if fragment else 'error'
    ordered = sorted(first.items(), key=lambda item: item[1])
    return [
        {
            'line': position[0],
            'column': position[1] + 1,
            'severity': severity,
            'message': "undefined name '%s'" % name,
        }
        for name, position in ordered
    ]


def __pta_compile_check(source, fragment):
    try:
        compile(source, '<pta>', 'exec')
    except (SyntaxError, IndentationError, TabError) as error:
        message = getattr(error, 'msg', '') or str(error)
        # 片段插进裁判程序后的缩进层级未知：缩进类报错不算学生的错，去掉缩进后再找未定义名字
        if fragment and __PTA_INDENT_ERROR.search(message):
            try:
                return __pta_json.dumps(__pta_undefined_names(ast.parse(textwrap.dedent(source)), fragment))
            except (SyntaxError, ValueError):
                return '[]'
        line = getattr(error, 'lineno', None) or 1
        text = getattr(error, 'text', None) or ''
        offset = getattr(error, 'offset', None) or 1
        # 缩进错误常把位置指在行首空白里：挪到第一个非空白字符，波浪线才不会画在上一行
        indent = len(text) - len(text.lstrip(' \t'))
        if indent:
            offset = max(offset, indent + 1)
        prefix = text[:max(0, offset - 1)]
        # 列号按 UTF-8 字节给：宿主用 offsetOfPosition 换算成字符下标，中文注释不会指偏
        return __pta_json.dumps([{
            'line': line,
            'column': len(prefix.encode('utf-8')) + 1,
            'severity': 'error',
            'message': message,
        }])
    except ValueError as error:
        # 源码里有 NUL 之类，compile 自己拒绝且不给位置：指到第一行
        return __pta_json.dumps([{'line': 1, 'column': 1, 'severity': 'error', 'message': str(error)}])
    try:
        tree = ast.parse(source)
    except (SyntaxError, ValueError):
        return '[]'
    return __pta_json.dumps(__pta_undefined_names(tree, fragment))
`);
  pythonCheckerReady = true;
}

/**
 * Python 检查结果（JSON 数组）→ 与 clang 同形状的诊断文本。
 * 与 compile.ts 的 pythonCheckOutput 保持一致。
 */
function pythonCheckOutput(items) {
  const lines = [];
  let hasError = false;
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    if (typeof item.message !== 'string' || !item.message) continue;
    const severity = item.severity === 'warning' ? 'warning' : 'error';
    if (severity === 'error') hasError = true;
    lines.push(`<pta>:${Number(item.line) || 1}:${Number(item.column) || 1}: ${severity}: ${item.message}\n`);
  }
  return { compileOutput: lines.join(''), hasError };
}

async function checkPython({ id, code, prelude }) {
  const started = Date.now();
  // 先报 check 阶段：宿主从这里开始按「检查」预算计时，加载 Pyodide 的时间也算在里面
  postMessage({ id, type: 'stage', stage: 'check' });

  let py;
  try {
    py = await getPyodide();
    ensurePythonChecker(py);
  } catch (error) {
    postMessage({ id, type: 'done', result: {
      stage: 'engine-error',
      message: `内置 Python 检查器加载失败：${error?.message ?? error}`,
      elapsedMs: Date.now() - started,
    } });
    return;
  }

  // compile + ast 都只做静态检查，绝不执行用户代码；prelude = 代码填空片段，未定义名字降为 warning
  let payload = '';
  try {
    py.globals.set('__pta_source', code);
    py.globals.set('__pta_fragment', prelude === true);
    payload = py.runPython('__pta_compile_check(__pta_source, __pta_fragment)');
  } catch (error) {
    postMessage({ id, type: 'done', result: {
      stage: 'engine-error',
      message: `Python 语法检查失败：${error?.message ?? error}`,
      elapsedMs: Date.now() - started,
    } });
    return;
  } finally {
    try { py.globals.delete('__pta_source'); } catch {}
    try { py.globals.delete('__pta_fragment'); } catch {}
  }

  let items = [];
  if (typeof payload === 'string' && payload !== '') {
    let parsed = null;
    try {
      parsed = JSON.parse(payload);
    } catch {
      parsed = null;
    }
    if (!Array.isArray(parsed)) {
      postMessage({ id, type: 'done', result: {
        stage: 'engine-error',
        message: 'Python 检查结果无法解析',
        elapsedMs: Date.now() - started,
      } });
      return;
    }
    items = parsed;
  }

  const { compileOutput, hasError } = pythonCheckOutput(items);
  postMessage({ id, type: 'done', result: {
    stage: hasError ? 'compile-error' : 'ok',
    stdout: '',
    stderr: '',
    // 与 C/C++ 的 clang 诊断同一种形状：宿主复用 parseClangDiagnostics
    compileOutput,
    exitCode: hasError ? 1 : 0,
    trap: null,
    message: '',
    elapsedMs: Date.now() - started,
  } });
}

/* ---------- C ---------- */

async function handle(ev) {
  const { id, code, stdin, lang, check } = ev.data ?? {};
  if (typeof id !== 'number' || typeof code !== 'string') return;

  // Python 实时检查：compile + AST，不执行；必须排在下面的运行分支前面
  if (lang === 'python' && check === true) {
    await checkPython({ id, code, prelude: ev.data?.prelude === true });
    return;
  }

  if (lang === 'python') {
    await runPython({ id, code, stdin: typeof stdin === 'string' ? stdin : '' });
    return;
  }

  // 实时检查：只做语法检查，不链接不运行
  if (check === true) {
    postMessage({ id, type: 'stage', stage: 'prepare' });
    let checkEngine;
    try {
      checkEngine = await getEngine();
    } catch (error) {
      postMessage({ id, type: 'done', result: {
        stage: 'engine-error',
        message: `内置编译器加载失败：${error?.message ?? error}`,
      } });
      return;
    }
    // 引擎就绪：接下来的时间才真正花在 -fsyntax-only 上（宿主的检查预算从这里算）
    postMessage({ id, type: 'stage', stage: 'check' });
    const checked = await checkOnEngine(checkEngine, { code, lang, prelude: ev.data?.prelude === true });
    if (checked.stage === 'engine-error') engine = null; // 下次重建
    postMessage({ id, type: 'done', result: checked });
    return;
  }

  postMessage({ id, type: 'stage', stage: 'prepare' });
  let current;
  try {
    current = await getEngine();
  } catch (error) {
    postMessage({ id, type: 'done', result: {
      stage: 'engine-error',
      message: `内置编译器加载失败：${error?.message ?? error}`,
    } });
    return;
  }

  const result = await runOnEngine(current, {
    code,
    lang,
    stdin: typeof stdin === 'string' ? stdin : '',
    onStage: (stage) => postMessage({ id, type: 'stage', stage }),
  });

  if (result.stage === 'engine-error') engine = null; // 下次重建
  postMessage({ id, type: 'done', result });
}

// 引擎单线程，一次只跑一个请求；队列化防并发把日志切片搅乱
let queue = Promise.resolve();
self.onmessage = (ev) => {
  const id = ev.data?.id;
  queue = queue.then(() => handle(ev)).catch((error) => {
    // handle 正常应该把失败包成 result 回话；这里兜底，
    // 别让请求在宿主那边白白等到超时（超时会把整个引擎重启一遍）
    if (typeof id !== 'number') return;
    postMessage({ id, type: 'done', result: {
      stage: 'engine-error',
      message: `编译引擎异常：${error?.message ?? error}`,
    } });
  });
};
