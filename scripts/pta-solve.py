#!/usr/bin/env python3
"""验收脚本：用插件（模型 + 工具）把一组 Python 编程题过掉。

用法：
    /tmp/pta-venv/bin/python scripts/pta-solve.py <题目URL> [更多URL...]

走的是**用户真正会走的路**：打开悬浮窗 → 在输入框里打字 → 点「发送」。
（不能直接发 chat/start 消息：面板里的 useChat 只认自己那次 send 发的 requestId，
绕过去的话面板收不到事件，工具也不会被调。）

结果从插件自己的持久化对话里读（chrome.storage.local 的 pta-assistant-chat）：
模型调用工具时页面可能被 refresh_page 重新载入，按消息收事件的做法会跟着断，
读存盘的结果就稳了——顺带也把「刷新不丢对话」这件事一起验了。
"""
import json
import re
import sys
import time

from playwright.sync_api import sync_playwright

CDP = "http://127.0.0.1:9222"

PROMPT = (
    "请解决当前 PTA 页面上的这道编程题，并提交直到通过。步骤：\n"
    "1. 先用 read_problem 读题面（看清输入输出格式和样例）。\n"
    "2. 写好 Python 代码后用 write_editor_code 写进作答区。\n"
    "3. 用 compile_and_run_python 拿题面样例跑一遍，输出不对就改，直到样例通过。\n"
    "4. 用 submit_answer 提交。**提交前先用 close_dialogs 关掉可能残留的提交结果 dialog**。\n"
    "5. 用 read_judge_result 等判题结论。如果结论是 PC（部分正确）或 WA，继续改代码再提交。\n"
    "6. 拿到 AC 就停下来，把最终代码贴给我。\n"
    "不要问我问题（我授权你直接改作答区），自己判断。"
)

STORE_KEY = "pta-assistant-chat"
VERDICT = re.compile(r"判题结论：([A-Z]+)")


def extension_world(page):
    """插件 content script 的隔离世界（Playwright 的 evaluate 只在页面主世界跑，拿不到 chrome.*）。"""
    client = page.context.new_cdp_session(page)
    contexts = []
    client.on("Runtime.executionContextCreated", lambda event: contexts.append(event["context"]))
    client.send("Runtime.enable")
    page.wait_for_timeout(1000)
    for context in contexts:
        if context.get("name") == "PTA 助手":
            return client, context["id"]
    client.detach()
    raise RuntimeError("没找到插件 content script 的隔离世界（扩展没注入？）")


def in_extension(page, expression):
    client, context_id = extension_world(page)
    try:
        result = client.send(
            "Runtime.evaluate",
            {
                "contextId": context_id,
                "awaitPromise": True,
                "returnByValue": True,
                "expression": expression,
            },
        )
    finally:
        client.detach()
    if result.get("exceptionDetails"):
        raise RuntimeError(json.dumps(result["exceptionDetails"], ensure_ascii=False)[:400])
    return result.get("result", {}).get("value")


def bucket_key(url):
    """和插件里的 conversationKey() 一致：origin + pathname + search。"""
    from urllib.parse import urlsplit

    parts = urlsplit(url)
    return f"{parts.scheme}://{parts.netloc}{parts.path}?{parts.query}"


def read_stored(page, key):
    """从插件的持久化存储里读这一道题的对话。"""
    raw = in_extension(
        page,
        "(async ({storeKey, key}) => {"
        "  const raw = await chrome.storage.local.get(storeKey);"
        "  return JSON.stringify((raw[storeKey] || {})[key] || []);"
        "})(" + json.dumps({"storeKey": STORE_KEY, "key": key}) + ")",
    )
    return json.loads(raw) if raw else []


def clear_stored(page, key):
    in_extension(
        page,
        "(async ({storeKey, key}) => {"
        "  const raw = await chrome.storage.local.get(storeKey);"
        "  const store = raw[storeKey] || {};"
        "  delete store[key];"
        "  await chrome.storage.local.set({[storeKey]: store});"
        "  return 'cleared';"
        "})(" + json.dumps({"storeKey": STORE_KEY, "key": key}) + ")",
    )


def open_panel(page):
    """打开悬浮窗（等价于点工具栏图标）。"""
    for _ in range(6):
        try:
            in_extension(
                page,
                "(async () => {"
                "  const tabs = await chrome.tabs.query({url: 'https://pintia.cn/*'});"
                "  await chrome.tabs.sendMessage(tabs[0].id, {type: 'toggle-panel'});"
                "  return 'toggled';"
                "})()",
            )
            return
        except RuntimeError as error:
            if "Receiving end does not exist" not in str(error):
                raise
            time.sleep(3)
    raise RuntimeError("后台一直没起来")


def type_and_send(page, text):
    """在悬浮窗的输入框里打字并点「发送」——和用户操作完全一样。"""
    page.evaluate(
        """(text) => {
          const host = document.querySelector('#pta-assistant-host');
          const root = host && host.shadowRoot;
          if (!root) throw new Error('悬浮窗没注入');
          const input = root.querySelector('textarea.composer__input');
          if (!input) throw new Error('找不到输入框');
          const setter = Object.getOwnPropertyDescriptor(
            window.HTMLTextAreaElement.prototype, 'value').set;
          setter.call(input, text);
          input.dispatchEvent(new Event('input', { bubbles: true }));
          return input.value.length;
        }""",
        text,
    )
    page.wait_for_timeout(300)
    page.evaluate(
        """() => {
          const root = document.querySelector('#pta-assistant-host').shadowRoot;
          const button = Array.from(root.querySelectorAll('button'))
            .find((b) => (b.innerText || '').trim() === '发送');
          if (!button) throw new Error('找不到「发送」按钮');
          button.click();
          return 'sent';
        }""",
    )


def wait_for_turn(page, key, timeout_s=420):
    """等这一轮跑完：没有工具还在跑、并且最后一条 assistant 消息已经落地。"""
    deadline = time.time() + timeout_s
    last = []
    while time.time() < deadline:
        time.sleep(6)
        try:
            messages = read_stored(page, key)
        except RuntimeError:
            continue  # 页面正在重新载入
        if not messages:
            continue
        last = messages
        running = [m for m in messages if m.get("toolStatus") == "running"]
        if running:
            continue
        for message in reversed(messages):
            if message.get("role") == "assistant" and (message.get("content") or "").strip():
                return messages
    return last


def summarize(messages):
    tools = []
    for message in messages:
        if message.get("role") == "tool":
            tools.append((message.get("toolName") or "?", message.get("content") or ""))
    verdict = None
    for _, result in tools:
        for match in VERDICT.finditer(result):
            verdict = match.group(1)
    final = ""
    for message in reversed(messages):
        if message.get("role") == "assistant" and (message.get("content") or "").strip():
            final = message["content"]
            break
    return tools, verdict, final


def read_submission_list(page, set_id):
    """读 PTA 自己的提交记录页：这是最权威的判题结论（插件把弹窗关掉也不影响它）。

    表格每行是：提交时间 / 状态 / 分数 / 题号 / 编译器 / …，
    题号就是「7-1」这种，跟题目列表里对得上。
    """
    page.goto(f"https://pintia.cn/problem-sets/{set_id}/exam/submissions", wait_until="domcontentloaded")
    page.wait_for_timeout(3000)
    return page.evaluate(
        """() => {
          const rows = Array.from(document.querySelectorAll('tr'));
          const out = [];
          for (const row of rows) {
            const cells = Array.from(row.querySelectorAll('td')).map((c) => (c.innerText || '').trim());
            if (cells.length < 4) continue;
            const problem = cells.find((c) => /^\\d+-\\d+$/.test(c));
            const status = cells.find((c) => /Accepted|Wrong Answer|Partial|Runtime|Compile|Time Limit|Memory|Presentation|Compile Error|Non-zero/i.test(c));
            if (!problem || !status) continue;
            out.push({ problem, status, at: cells[0] });
          }
          return out;
        }""",
    )


def main():
    urls = sys.argv[1:]
    if not urls:
        print("用法：pta-solve.py <题目URL> [更多URL...]")
        return 1

    with sync_playwright() as playwright:
        browser = playwright.chromium.connect_over_cdp(CDP)
        context = browser.contexts[0]
        page = None
        for candidate in context.pages:
            if "pintia.cn" in candidate.url and "extensions" not in candidate.url:
                page = candidate
                break
        if page is None:
            page = context.new_page()

        for url in urls:
            key = bucket_key(url)
            page.goto(url, wait_until="domcontentloaded")
            page.wait_for_timeout(3000)
            title = page.evaluate("() => document.title.split(' - ')[0]").strip()
            print(f"\n===== {title} =====", flush=True)
            try:
                clear_stored(page, key)
                open_panel(page)
                page.wait_for_timeout(800)
                type_and_send(page, PROMPT)
            except Exception as error:  # noqa: BLE001 - 验收脚本：任何失败都要看得见
                print(f"  出错：{error}", flush=True)
                continue
            messages = wait_for_turn(page, key)
            tools, verdict, final = summarize(messages)
            for name, result in tools:
                head = result.split("\n")[0][:130]
                print(f"  [{name}] {head}", flush=True)
            print(f"  => 插件读到的结论：{verdict or '（没拿到结论）'}", flush=True)
            print(f"  => 最终回答：{final[:400]}", flush=True)

        # 最后统一去 PTA 的提交记录页看一眼——那里的结论才是权威的
        set_id = urls[0].split("/problem-sets/")[1].split("/")[0]
        print("\n===== PTA 提交记录（权威结论） =====", flush=True)
        for row in read_submission_list(page, set_id):
            print(f"  {row['problem']:<8} {row['status']:<20} {row['at']}", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
