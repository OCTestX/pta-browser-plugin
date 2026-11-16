// 内置 C 编译器的资源清单：下载（fetch-engine.mjs）与打包（package-firefox.mjs）共用。
// 单独放一个文件，是为了让打包脚本能 import 而不会顺手触发下载。
//
// 来源：cppstudio-io/wasm-clang-runtime v0.1.0（Apache-2.0）
//   clang22-noeh / lld22-noeh：Clang 22.1.8 + LLD 编译成的 wasm（剥掉 exnref 指令的兼容版）
//   sysroot22.tar：wasi-sdk 33 的 sysroot（C 头文件 + libc.a）
// memfs 不在上游 Release 里，已按上游 src/memfs/build.sh 用 wasi-sdk 33 重新编译，随仓库走。
export const ENGINE_BASE_URL = 'https://github.com/cppstudio-io/wasm-clang-runtime/releases/download/v0.1.0';

export const ENGINE_ASSETS = [
  { name: 'clang22-noeh', size: 36100574, sha256: 'e01346e33b31a3b3359a317450502bd4feb78cd6ca7fed08aca8601f9ff8834d' },
  { name: 'lld22-noeh', size: 19183252, sha256: '63c397c582e193aacd96fbdeb04b1bd32f47ae505f6dc4a569ed08a80ddfeff7' },
  { name: 'sysroot22.tar', size: 39876608, sha256: 'd991c621cdf9b4640c2cd4aa21abb08491c2ae6ef9917cac5c6065553604bcec' },
];
