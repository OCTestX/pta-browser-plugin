#!/usr/bin/env python3
"""真机测试的脚手架：接管已经开着的浏览器，用插件自己的消息接口驱动它的 agent loop。

用法：
    /tmp/pta-venv/bin/python scripts/pta-drive.py read <url>
    /tmp/pta-venv/bin/python scripts/pta-drive.py chat <url> "<提示词>"
    /tmp/pta-venv/bin/python scripts/pta-drive.py tools <url>

之所以走插件自己的消息接口（而不是自己调页面脚本）：
这样测的就是用户真正用到的那条链路——模型请求 → 工具执行 → 结果回灌 → 面板渲染。
"""
import json
import sys

from playwright.sync_api import sync_playwright

CDP = "http://127.0.0.1:9222"


def open_page(context, url):
    page = None
    for candidate in context.pages:
        if "pintia.cn" in candidate.url:
            page = candidate
            break
    if page is None:
        page = context.new_page()
    page.goto(url, wait_until="domcontentloaded")
    page.wait_for_timeout(2500)
    return page


def extension_world(page):
    """找到插件 content script 的隔离世界（Playwright 的 evaluate 只在页面主世界跑，拿不到 chrome.*）。"""
    client = page.context.new_cdp_session(page)
    contexts = []
    client.on("Runtime.executionContextCreated", lambda event: contexts.append(event["context"]))
    client.send("Runtime.enable")
    page.wait_for_timeout(800)
    for context in contexts:
        if context.get("name") == "PTA 助手":
            return client, context["id"]
    raise RuntimeError("没找到插件 content script 的隔离世界（扩展没注入？）")


def run_turn(page, prompt, wait_ms=120_000):
    """在插件的 content script 里跑一轮对话，把工具调用与结果都收回来。"""
    client, context_id = extension_world(page)
    result = client.send(
        "Runtime.evaluate",
        {
            "contextId": context_id,
            "awaitPromise": True,
            "returnByValue": True,
            "expression": """(async ({prompt, waitMs}) => {
              const names = new Map();
              const tools = [];
              const deltas = [];
              let final = '';
              const listener = (message) => {
                if (!message || typeof message.type !== 'string') return;
                if (message.type === 'chat/tool-start') {
                  // tool-end 只带 callId，工具名要靠这里记下来
                  names.set(message.callId, message.name);
                } else if (message.type === 'chat/tool-end') {
                  tools.push({
                    name: names.get(message.callId) || message.callId,
                    result: message.result,
                    isError: message.isError,
                  });
                } else if (message.type === 'chat/delta') {
                  deltas.push(message.text);
                } else if (message.type === 'chat/error') {
                  final += '\\n[错误] ' + message.message;
                }
              };
              chrome.runtime.onMessage.addListener(listener);
              await chrome.runtime.sendMessage({
                type: 'chat/start',
                requestId: 'drive-' + Date.now(),
                messages: [{ role: 'user', content: prompt }],
              });
              await new Promise((resolve) => setTimeout(resolve, waitMs));
              chrome.runtime.onMessage.removeListener(listener);
              return { tools, final: deltas.join('') + final };
            })(""" + json.dumps({"prompt": prompt, "waitMs": wait_ms}, ensure_ascii=False) + ")",
        },
    )
    client.detach()
    value = result.get("result", {}).get("value")
    if not value:
        raise RuntimeError(
            f"没拿到结果：{json.dumps(result, ensure_ascii=False)[:800]}\n"
            f"（contextId={context_id}）"
        )
    return value


def main():
    if len(sys.argv) < 3:
        print("用法：pta-drive.py <read|chat|tools> <url> [提示词]")
        return 1
    command, url = sys.argv[1], sys.argv[2]
    rest = sys.argv[3:]

    with sync_playwright() as playwright:
        browser = playwright.chromium.connect_over_cdp(CDP)
        context = browser.contexts[0]
        page = open_page(context, url)

        if command == "read":
            turn = run_turn(
                page, "调用 read_problem 工具，把返回结果原样贴出来，不要做别的。", 60_000
            )
            result = next((t for t in turn["tools"] if t["name"] == "read_problem"), None)
            print(result["result"] if result else "(没有拿到 read_problem 的结果)")
        elif command == "chat":
            turn = run_turn(page, " ".join(rest), 240_000)
            for tool in turn["tools"]:
                print(f"--- 工具 {tool['name']} ---")
                print(tool["result"])
            print("--- 最终回答 ---")
            print(turn["final"])
        elif command == "tools":
            turn = run_turn(
                page,
                "依次调用这三个工具并把结果原样贴出来：read_problem、read_editor_code、close_dialogs。不要做别的。",
                120_000,
            )
            for tool in turn["tools"]:
                print(f"--- {tool['name']} ---")
                print(tool["result"])
        else:
            print("用法：pta-drive.py <read|chat|tools> <url> [提示词]")
            return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
