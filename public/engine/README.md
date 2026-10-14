# 内置 C 编译器（engine/）

`compile_and_run_c` 工具用的本地编译环境：**Clang 22.1.8 + wasm-ld（LLD）+ wasi-sdk 33 的 sysroot**，
全部编译成 WebAssembly 在插件内部运行——代码不出本机、不依赖任何在线编译服务。

## 文件清单

| 文件 | 体积 | 来源 | 进 git |
| --- | --- | --- | --- |
| `shared.js` | ~30KB | 改编自 cppstudio-io/wasm-clang-runtime 的 shared.js（C 模式、stderr 分流、ESM 导出） | 是 |
| `engine-core.js` | ~5KB | 改编自其 compiler-bridge.js（C 专用配置 + 结构化结果） | 是 |
| `compile-worker.js` | ~2KB | 自写：Worker 侧协议与引擎单例 | 是 |
| `compiler-host.js` / `.html` | ~1KB | 自写：Chrome offscreen 页承载 Worker | 是 |
| `memfs` | ~97KB | 用 wasi-sdk 33 按上游 build.sh 从 memfs.c 编出的 wasm 内存文件系统 | 是 |
| `clang22-noeh` | ~34MB | 上游 Release（剥掉 exnref 指令的兼容版） | 否（fetch-engine.mjs 下载） |
| `lld22-noeh` | ~18MB | 同上 | 否 |
| `sysroot22.tar` | ~38MB | wasi-sdk 33 的 sysroot（C/C++ 头文件 + libc.a 等） | 否 |

三个大文件由 `npm run build`（前置的 `scripts/fetch-engine.mjs`）从
[cppstudio-io/wasm-clang-runtime v0.1.0](https://github.com/cppstudio-io/wasm-clang-runtime/releases/tag/v0.1.0)
下载，带 sha256 校验；只在缺失时下载，装好后就完全离线。

## 为什么用「noeh」版本

标准版 clang22/lld22 里各有一条 `try_table` 指令（exnref 异常处理提案），Chrome 125+ 才认；
noeh 版剥掉这条指令后功能不受影响（被剥的是 clang 驱动层的兜底 catch），
Chrome 63+ / Firefox 115+ / 各种国产内核 WebView 都能跑。sysroot 本身就是 noeh 变体。

## 运行架构

- **Chrome**：MV3 service worker 建不了 Worker，由 offscreen 文档（`compiler-host.html`）常驻承载编译 Worker；
  死循环 / 超时由后台下令 offscreen 杀 Worker 重开。
- **Firefox**：background 是 event page，直接 `new Worker`。
- **Worker 内**：`engine-core.js` 编排 clang `-cc1 -emit-obj` → wasm-ld 链接 → 用 WASI shim 运行用户程序，
  stdin 预喂、stdout/stderr 分开收集。引擎（sysroot 解包 + 模块缓存）建一次几秒，之后每次编译约一两秒。

## 许可

- `shared.js` / `engine-core.js` / 大文件资源链路：Apache-2.0（含 LLVM 的 Apache-2.0 + LLVM 例外）。
  上游 cppstudio-io/wasm-clang-runtime 又改编自 binji/wasm-clang（CppCon 2019 demo）。
- `memfs`：源码同属上述项目（Apache-2.0），本仓库按上游 `src/memfs/build.sh` 用 wasi-sdk 33 重新编译。
