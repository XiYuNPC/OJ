// judge-worker.js —— 浏览器内评测机（module 型 Web Worker）
// 技术栈：emception 1.0.15（WASM 版 clang/lld/python/quicknode 工具链）的底层组件，
//         通过相对路径 ESM 直接组装（emception.js 入口含 webpack 别名，无法在浏览器使用）。
// 评测流程：初始化工具链 → em++ 编译 main.cpp → 逐组注入 stdin 运行 main.js → 比对输出 → 回传结果。
//
// 判题口径（近似，与纯前端架构一致）：
//   TLE：本 worker 内执行是同步阻塞的，自身计时器无法触发，由页面主线程 watchdog 超时强杀实现；
//   MLE：编译期把 WASM 内存上限设为题目限制（下限 20MB），运行中 OOM abort 按 stderr 特征串识别；
//   timeMs 为 wall-clock 近似（含 WASM 启动开销），不统计内存（memoryKb 不回报）。
// 通信题（两进程函数式，protocol.driver 分流）：
//   two-phase（P12509 / 通用标量协议）：编译产物用 -sMODULARIZE=1 -sEXPORT_NAME='JudgeModule'
//   输出为工厂函数，每组数据「两次 new JudgeModule()」分别实例化协议 fn1 与 fn2 实例（严格两进程、
//   全局状态互不可见），fn1 返回的 X 由本 worker 在 JS 侧传递给 fn2 实例。签名按 protocol 声明
//   （类型菜单：参数 string / int / long long / vector<int>；返回 string / int / long long），
//   编译前由 generateTwoPhaseWrapper 注入 C 链接 wrapper（int 走 ccall "number"；long long 走
//   十进制字符串 strtoll/to_string、64 位全精度；string 走 char*；vector<int> 走 int* 缓冲）；
//   EXPORTED_FUNCTIONS 用 _oj_fn1/_oj_fn2 指代，ccall 用 oj_fn1/oj_fn2（不带前导下划线）。编译
//   不加 -sEXIT_RUNTIME（否则运行时退出后函数不可调），且因无 main，胶水不会自动 callMain。
//   测试数据约定：input 每行一个参数（依次 fn1 全部参数 → fn2 除 X 外参数），expectedOutput 为
//   期望 P。旧式只写函数名按默认签名 fn1(string)→int / fn2(string,int)→int（X 为第二参）处理。
//   stations（P6838 网络站点）：数组参数经 _malloc + HEAP32 缓冲区、数组返回值经 out 参数
//   读回（ccall 无法返回数组）；判定不用 expectedOutput，由内置 grader 验证（编号合法性 +
//   逐查询与 BFS 正确下一跳比对），测试数据为官方样例评测器格式（n k / n-1 条边 / q / q 行 z y）。
//
// 与主线程消息协议（入站）：
//   {type:"start", task:{submissionId, problemId, language, sourceCode,
//                       timeLimitMs, memoryLimitMb, testcases:[{ordinal, input, expectedOutput}]}}
// （出站）
//   {type:"init-start"} / {type:"init-done", tookMs}
//   {type:"compile-start"} / {type:"compile-done", tookMs}
//   {type:"case-start", ordinal, total} / {type:"case-done", ordinal, ok, actualOutput, timeMs}
//   {type:"done", verdict, details, timeMs}     verdict ∈ AC/WA/TLE/MLE/RE/CE
//   {type:"error", message}                     （业务异常：主线程不回传结果，提交保持 judging 可重试）

import FileSystem from "/vendor/emception/FileSystem.mjs";
import LlvmBoxProcess from "/vendor/emception/LlvmBoxProcess.mjs";
import BinaryenBoxProcess from "/vendor/emception/BinaryenBoxProcess.mjs";
import Python3Process from "/vendor/emception/Python3Process.mjs";
import NodeProcess from "/vendor/emception/QuickNodeProcess.mjs";

// emception 的 FileSystem 用 IDBFS 做 /cache 持久化，其胶水代码直接引用
// window.indexedDB 与 window.location.pathname。worker 全局没有 window，
// 但 indexedDB 与 location 在 worker 中都可用，做个别名即可。
globalThis.window = globalThis;

// 工具链资源包（36 个 .pack.br，按需懒加载；列表来自 node_modules/emception/packs.mjs）
const PACKS = {
  "cpython": "cpython",
  "emscripten": "emscripten",
  "emscripten_docs": "emscripten_docs",
  "emscripten_media": "emscripten_media",
  "emscripten_node_modules": "emscripten_node_modules",
  "emscripten_sysroot_lib_wasm32-emscripten_libGL.a": "emscripten_sysroot_lib_wasm32-emscripten_libGL.a",
  "emscripten_sysroot_lib_wasm32-emscripten_libal.a": "emscripten_sysroot_lib_wasm32-emscripten_libal.a",
  "emscripten_sysroot_lib_wasm32-emscripten_libc++-noexcept.a": "emscripten_sysroot_lib_wasm32-emscripten_libc++-noexcept.a",
  "emscripten_sysroot_lib_wasm32-emscripten_libc++.a": "emscripten_sysroot_lib_wasm32-emscripten_libc++.a",
  "emscripten_sysroot_lib_wasm32-emscripten_libc++abi-debug-noexcept.a": "emscripten_sysroot_lib_wasm32-emscripten_libc++abi-debug-noexcept.a",
  "emscripten_sysroot_lib_wasm32-emscripten_libc++abi-debug.a": "emscripten_sysroot_lib_wasm32-emscripten_libc++abi-debug.a",
  "emscripten_sysroot_lib_wasm32-emscripten_libc++abi-noexcept.a": "emscripten_sysroot_lib_wasm32-emscripten_libc++abi-noexcept.a",
  "emscripten_sysroot_lib_wasm32-emscripten_libc++abi.a": "emscripten_sysroot_lib_wasm32-emscripten_libc++abi.a",
  "emscripten_sysroot_lib_wasm32-emscripten_libc-debug.a": "emscripten_sysroot_lib_wasm32-emscripten_libc-debug.a",
  "emscripten_sysroot_lib_wasm32-emscripten_libc.a": "emscripten_sysroot_lib_wasm32-emscripten_libc.a",
  "emscripten_sysroot_lib_wasm32-emscripten_libcompiler_rt.a": "emscripten_sysroot_lib_wasm32-emscripten_libcompiler_rt.a",
  "emscripten_sysroot_lib_wasm32-emscripten_libdlmalloc.a": "emscripten_sysroot_lib_wasm32-emscripten_libdlmalloc.a",
  "emscripten_sysroot_lib_wasm32-emscripten_libhtml5.a": "emscripten_sysroot_lib_wasm32-emscripten_libhtml5.a",
  "emscripten_sysroot_lib_wasm32-emscripten_libnoexit.a": "emscripten_sysroot_lib_wasm32-emscripten_libnoexit.a",
  "emscripten_sysroot_lib_wasm32-emscripten_libsockets.a": "emscripten_sysroot_lib_wasm32-emscripten_libsockets.a",
  "emscripten_sysroot_lib_wasm32-emscripten_libstubs-debug.a": "emscripten_sysroot_lib_wasm32-emscripten_libstubs-debug.a",
  "emscripten_sysroot_lib_wasm32-emscripten_libstubs.a": "emscripten_sysroot_lib_wasm32-emscripten_libstubs.a",
  "emscripten_sysroot_lib_wasm32-emscripten_libz.a": "emscripten_sysroot_lib_wasm32-emscripten_libz.a",
  "emscripten_sysroot_lib_wasm32-emscripten_lto": "emscripten_sysroot_lib_wasm32-emscripten_lto",
  "emscripten_system_include": "emscripten_system_include",
  "emscripten_system_include_GL": "emscripten_system_include_GL",
  "emscripten_system_include_SDL": "emscripten_system_include_SDL",
  "emscripten_system_include_compat": "emscripten_system_include_compat",
  "emscripten_system_lib": "emscripten_system_lib",
  "emscripten_system_lib_compiler-rt_lib": "emscripten_system_lib_compiler-rt_lib",
  "emscripten_system_lib_compiler-rt_lib_sanitizer_common": "emscripten_system_lib_compiler-rt_lib_sanitizer_common",
  "emscripten_system_lib_libc_musl_src": "emscripten_system_lib_libc_musl_src",
  "emscripten_system_lib_libcxx_include": "emscripten_system_lib_libcxx_include",
  "emscripten_system_lib_libcxx_src": "emscripten_system_lib_libcxx_src",
  "emscripten_third_party": "emscripten_third_party",
  "wasm": "wasm",
};

// 启动即预热的资源包（编译 C++ 所需的最小集，列表来自 emception.js 的 preloads）
const PRELOADS = [
  "cpython",
  "emscripten",
  "emscripten_node_modules",
  "emscripten_sysroot_lib_wasm32-emscripten_libGL.a",
  "emscripten_sysroot_lib_wasm32-emscripten_libal.a",
  "emscripten_sysroot_lib_wasm32-emscripten_libc++.a",
  "emscripten_sysroot_lib_wasm32-emscripten_libc++abi.a",
  "emscripten_sysroot_lib_wasm32-emscripten_libc.a",
  "emscripten_sysroot_lib_wasm32-emscripten_libcompiler_rt.a",
  "emscripten_sysroot_lib_wasm32-emscripten_libdlmalloc.a",
  "emscripten_sysroot_lib_wasm32-emscripten_libhtml5.a",
  "emscripten_sysroot_lib_wasm32-emscripten_libsockets.a",
  "emscripten_sysroot_lib_wasm32-emscripten_libstubs.a",
  "emscripten_system_include",
  "emscripten_system_include_SDL",
  "emscripten_system_include_compat",
  "emscripten_system_lib_compiler-rt_lib",
  "emscripten_system_lib_libcxx_include",
  "emscripten_third_party",
  "wasm",
];

// 命令 → 工具映射（与 emception.js 的 tools_info 一致）
const TOOLS_INFO = {
  "/usr/bin/clang": "llvm-box",
  "/usr/bin/clang++": "llvm-box",
  "/usr/bin/llc": "llvm-box",
  "/usr/bin/lld": "llvm-box",
  "/usr/bin/llvm-ar": "llvm-box",
  "/usr/bin/llvm-nm": "llvm-box",
  "/usr/bin/llvm-objcopy": "llvm-box",
  "/usr/bin/wasm-ld": "llvm-box",
  "/usr/bin/node": "node",
  "/usr/bin/python": "python",
  "/usr/bin/wasm-as": "binaryen-box",
  "/usr/bin/wasm2js": "binaryen-box",
  "/usr/bin/wasm-ctor-eval": "binaryen-box",
  "/usr/bin/wasm-emscripten-finalize": "binaryen-box",
  "/usr/bin/wasm-metadce": "binaryen-box",
  "/usr/bin/wasm-opt": "binaryen-box",
  "/usr/bin/wasm-shell": "binaryen-box",
};

let fs = null;   // FileSystem（WASM 虚拟文件系统，含 IDBFS 持久化 /cache）
let tools = null; // 各工具进程实例（init 后均为数组，按空闲选择）
let task = null;  // 当前评测任务包

const post = (msg) => self.postMessage(msg);

// ---------- 工具链初始化（复刻 emception.js 的 init()，剔除 webpack 依赖） ----------

let initPromise = null;
function ensureInit() {
  if (!initPromise) initPromise = init();
  return initPromise;
}

async function init() {
  post({ type: "init-start" });
  const t0 = performance.now();

  const fileSystem = await new FileSystem();
  fileSystem.mkdirTree("/lazy");
  for (const [name] of Object.entries(PACKS)) {
    fileSystem.cachedLazyFolder(`/lazy/${name}`, `/vendor/emception/packages/${name}.pack.br`, 0o777, `/lazy/${name}`);
  }

  fileSystem.mkdirTree("/usr/local");
  fileSystem.symlink("/lazy/emscripten", "/emscripten");
  fileSystem.symlink("/lazy/cpython", "/usr/local/lib");
  fileSystem.symlink("/lazy/wasm", "/wasm");

  for (const preload of PRELOADS) {
    await fileSystem.preloadLazy(`/lazy/${preload}`);
  }

  fileSystem.mkdirTree("/working");
  fileSystem.mkdirTree("/usr/bin");
  for (const toolPath of Object.keys(TOOLS_INFO)) {
    // emscripten 驱动脚本会检查这些文件是否存在
    fileSystem.writeFile(toolPath, "");
  }

  const processConfig = {
    FS: fileSystem.FS,
    onrunprocess: (...args) => runProcess(...args),
  };

  tools = {
    "llvm-box": new LlvmBoxProcess(processConfig),
    "binaryen-box": new BinaryenBoxProcess(processConfig),
    "node": new NodeProcess(processConfig),
    "python": [
      new Python3Process(processConfig),
      new Python3Process(processConfig),
      new Python3Process(processConfig),
    ],
  };
  // 统一包装成数组（单实例也包装），runProcess 里按空闲查找
  for (const t in tools) {
    tools[t] = await Promise.all([].concat(tools[t]));
  }

  fs = fileSystem;
  post({ type: "init-done", tookMs: Math.round(performance.now() - t0) });
}

// ---------- 进程执行（复刻 emception.js 的 _run_process_impl） ----------

function runProcess(argv, opts = {}) {
  const m = argv[0].match(/^((\/lazy)?\/emscripten\/.+?)(?:\.py)?$/);
  const emscriptenScript = m && m[1];
  if (emscriptenScript && fs.exists(`${emscriptenScript}.py`)) {
    argv = ["/usr/bin/python", "-E", `${emscriptenScript}.py`, ...argv.slice(1)];
  }

  const toolName = TOOLS_INFO[argv[0]];
  const tool = tools[toolName] && tools[toolName].find((p) => !p.running);
  if (!tool) {
    return { returncode: 1, stdout: "", stderr: `Emception tool not found: ${JSON.stringify(argv[0])}` };
  }

  const result = tool.exec(argv, { ...opts, cwd: opts.cwd || "/", path: ["/emscripten"] });
  fs.push(); // IDBFS 缓存落盘（异步，不阻塞）
  return result;
}

// emscripten 驱动命令（em++/emcc），等价于 emception.js 的 run()
function emrun(...args) {
  if (fs.exists("/emscripten/cache/cache.lock")) fs.unlink("/emscripten/cache/cache.lock");
  return runProcess([`/emscripten/${args[0]}.py`, ...args.slice(1)], {
    print: () => {},
    printErr: () => {},
    cwd: "/working",
    path: ["/emscripten"],
  });
}

// ---------- 评测 ----------

// 输出比对口径：逐行忽略行尾空白，忽略末尾空行与首尾空白（常见 OJ 口径）
function normalize(s) {
  const lines = String(s ?? "").split("\n").map((l) => l.replace(/[ \t\r]+$/, ""));
  while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
  return lines.join("\n").trim();
}

// OOM 特征串（emscripten 内存上限触顶时 abort 的 stderr / C++ new 失败抛的 bad_alloc）
function isOom(stderr) {
  return /cannot enlarge memory|out of memory|OOM|memory limit exceeded|allocation failed|bad_alloc/i.test(stderr || "");
}

// 运行一组测试：在 worker 的真实浏览器 V8 里直接执行 main.js（与官方 demo 的「浏览器内 eval
// 运行编译产物」同路径，绕开 quicknode——其实测为 WASM 版 node 12，无法实例化 wasm 模块，
// 抛裸 TypeError: not a function）。
// 机制：
//   1) new Function("Module", mainJs)(mod)——预设 Module 作为函数参数注入（与 llvm-box.mjs
//      包装胶水的方式一致）：胶水首行 var Module=typeof Module!="undefined"?Module:{} 的函数
//      作用域变量会遮蔽全局预置，只有参数注入能保留预置值。SINGLE_FILE 的 wasm 内嵌于
//      main.js，实例化走 WebAssembly.instantiate（异步），run() 依赖完成后自动 callMain。
//   2) mod 提供：stdin 逐字节回调（initRuntime 自动 FS.init 保留预置，createStandardStreams
//      以 createDevice 建立设备，read 循环逐字节调 input()、null=EOF）；stdout/stderr 逐字节
//      设备采集（规避 /dev/tty 行缓冲丢无换行尾行，各上限 256KB）；print/printErr 收进
//      stderr；onExit/onAbort 记录退出码并 resolve 完成 Promise（exitJS→_proc_exit 先调
//      onExit(code) 再抛 ExitStatus——被 callMain 内部 handleException 吞掉、正常返回；
//      abort 则抛 WebAssembly.RuntimeError 沿异步链冒泡）。
//   3) 异步异常兜底：main 总在微任务中运行（instantiateAsync 恒异步），try/catch 只兜同步
//      顶层错误；胶水/程序运行时异常由 runCase 期间临时挂上的 worker 级 error 与
//      unhandledrejection 监听捕获（用完即拆），异常栈第一帧 <anonymous>:1:列号 即 main.js
//      内偏移，附偏移附近 400 字符片段，退出码置 1。
//   4) 程序不退出时 await 永不返回，由主线程 watchdog 按 TLE 强杀（与 v4 一致）。
async function runCase(mainJs, input) {
  const data = new TextEncoder().encode(input ?? "");
  let pos = 0, outStr = "", errStr = "", exitStatus = 0;
  let settle;
  const done = new Promise((resolve) => { settle = resolve; });

  // 胶水 web 分支引用 document（setWindowTitle/currentScript），worker 无此全局，给最小 stub。
  // 工具链进程均已初始化完毕，此 stub 不影响它们。
  if (!globalThis.document) globalThis.document = { currentScript: null };

  const mod = {
    stdin: () => (pos < data.length ? data[pos++] : null),
    stdout: (b) => { if (outStr.length < 262144) outStr += String.fromCharCode(b); },
    stderr: (b) => { if (errStr.length < 262144) errStr += String.fromCharCode(b); },
    print: (...a) => { if (errStr.length < 262144) errStr += a.join(" ") + "\n"; },
    printErr: (...a) => { if (errStr.length < 262144) errStr += a.join(" ") + "\n"; },
    onExit: (code) => { exitStatus = code; settle(); },
    onAbort: () => { if (exitStatus === 0) exitStatus = 1; settle(); },
  };

  const onErr = (ev) => {
    const ex = ev.error || ev.reason;
    const stack = String((ex && ex.stack) || ex);
    if (exitStatus === 0) exitStatus = 1;
    errStr += "\n" + stack;
    const m = stack.match(/:(\d+):(\d+)/);
    if (m && m[1] === "1") {
      const col = parseInt(m[2], 10);
      errStr += "\n[main.js 偏移 " + col + " 附近]\n" + mainJs.slice(Math.max(0, col - 150), col + 250);
    }
    settle();
  };
  self.addEventListener("error", onErr);
  self.addEventListener("unhandledrejection", onErr);

  const t0 = performance.now();
  try {
    new Function("Module", mainJs)(mod);
  } catch (ex) {
    onErr({ error: ex });
  }
  await done;
  self.removeEventListener("error", onErr);
  self.removeEventListener("unhandledrejection", onErr);

  // 近似内存：WASM 堆大小（HEAPU8 长度）。普通题现在 INITIAL_MEMORY=题限、不 grow，
  // 故此值恒等于题限（非精确 malloc 峰值）；普通题 MLE 判定改走 stderr 特征串，不依赖此值。
  let memoryKb = null;
  try { if (mod.HEAPU8 && mod.HEAPU8.length) memoryKb = Math.round(mod.HEAPU8.length / 1024); } catch (e) {}

  return { returncode: exitStatus, stdout: outStr, stderr: errStr, timeMs: Math.round(performance.now() - t0), memoryKb };
}

function caseDetail(tc, ok, actualOutput) {
  return {
    ordinal: tc.ordinal,
    ok,
    input: tc.input,
    expectedOutput: tc.expectedOutput,
    actualOutput,
  };
}

// 合成 bits/stdc++.h 用的候选头（emscripten 使用 libc++，不提供 libstdc++ 的万能头；
// 生成时逐个探测 sysroot 中实际存在的文件，缺失的自动跳过）。
// 口径：仅收录 C++11/14/17 核心头；C++20 专属（ranges/concepts/coroutine/format/span 等）
// 与线程同步类头（mutex/thread 等）不收录——在 -std=c++17 与无 -pthread 环境下本就不可用，
// 用到这些特性的提交按 CE 处理。
const STDCXX_CANDIDATES = [
  "algorithm", "any", "array", "atomic", "bit", "bitset", "cassert", "cctype",
  "cerrno", "cfenv", "cfloat", "charconv", "chrono", "cinttypes", "ciso646", "climits",
  "clocale", "cmath", "complex", "csetjmp", "csignal", "cstdarg", "cstdbool", "cstddef",
  "cstdint", "cstdio", "cstdlib", "cstring", "ctime", "cwchar", "cwctype", "deque",
  "exception", "forward_list", "fstream", "functional", "initializer_list", "iomanip",
  "ios", "iosfwd", "iostream", "istream", "iterator", "limits", "list", "locale",
  "map", "memory", "new", "numeric", "optional", "ostream", "queue", "random", "ratio",
  "regex", "scoped_allocator", "set", "sstream", "stack", "stdexcept", "streambuf",
  "string", "string_view", "system_error", "tuple", "type_traits", "typeindex",
  "typeinfo", "unordered_map", "unordered_set", "utility", "valarray", "variant", "vector",
];

// 生成 /working/bits/stdc++.h（clang 经 -I/working 优先命中）：
// 探测 libc++ 头目录（sysroot 内 v1；若缺失则退回独立包根）→ 按候选列表拼接 include
function ensureStdCppHeader() {
  const candidates = [
    "/lazy/emscripten/cache/sysroot/include/c++/v1",
    "/lazy/emscripten_system_lib_libcxx_include",
  ];
  const incDir = candidates.find((dir) => fs.exists(`${dir}/algorithm`));
  if (!incDir) return; // 头目录异常时不注入，编译按缺头报 CE，不误判
  const found = STDCXX_CANDIDATES.filter((name) => fs.exists(`${incDir}/${name}`));
  const body = found.map((name) => `#include <${name}>`).join("\n");
  fs.mkdirTree("/working/bits");
  fs.writeFile(
    "/working/bits/stdc++.h",
    "// 评测机合成的万能头（emscripten/libc++ 不提供 libstdc++ 的 bits/stdc++.h）\n" +
      "#ifndef WEBOJ_BITS_STDCXX_H\n#define WEBOJ_BITS_STDCXX_H\n\n" +
      body + "\n\n#endif\n"
  );
}

// 编译 C++ 源码为 SINGLE_FILE main.js（评测与自定义运行共用）。
// 内存口径：INITIAL_MEMORY 直接设为题限（下限 20MB）、不 ALLOW_MEMORY_GROWTH。
// malloc 超题限立即失败（C++ operator new 抛 std::bad_alloc / abort），由 runCase 的
// stderr 特征串（含 bad_alloc / out of memory 等）识别 MLE；口径与通信题保持一致。
async function compileCpp(sourceCode, memoryLimitMb) {
  const t0 = performance.now();
  fs.writeFile("/working/main.cpp", sourceCode);
  ensureStdCppHeader();
  const limitBytes = Math.max(memoryLimitMb || 64, 20) * 1024 * 1024;
  const compile = emrun(
    "em++", "-O2", "-fexceptions",
    "-sSINGLE_FILE=1", "-sEXIT_RUNTIME=1",
    "-sINITIAL_MEMORY=" + limitBytes, "-sTOTAL_STACK=2097152",
    "-std=c++17", "-I/working",
    "main.cpp", "-o", "main.js"
  );
  const timeMs = Math.round(performance.now() - t0);
  if (compile.returncode !== 0) {
    return { ok: false, errText: (compile.stderr || compile.stdout || "编译失败").slice(0, 4000), timeMs };
  }
  return { ok: true, mainJs: fs.readFile("/working/main.js", { encoding: "utf8" }), timeMs };
}

// 自定义运行：编译 + 对用户输入单组运行（供题目页「运行代码」使用，不产生提交记录）。
// 协议：run-compile-start → (run-compile-error | run-start → run-done) | run-error
async function runCustom(task) {
  await ensureInit();
  post({ type: "run-compile-start" });
  const built = await compileCpp(task.sourceCode, task.memoryLimitMb);
  if (!built.ok) {
    post({ type: "run-compile-error", stderr: built.errText, timeMs: built.timeMs });
    return;
  }
  post({ type: "run-start" });
  const r = await runCase(built.mainJs, task.input);
  // 单组判定：运行出错 → MLE/RE；填了预期输出才判 AC/WA，否则 verdict 为 null（仅展示运行结果）
  let verdict = null;
  if (r.returncode !== 0) {
    verdict = isOom(r.stderr) ? "MLE" : "RE";
  } else if (task.expectedOutput != null && task.expectedOutput !== "") {
    verdict = normalize(r.stdout) === normalize(task.expectedOutput) ? "AC" : "WA";
  }
  post({ type: "run-done", verdict, stdout: r.stdout, stderr: r.stderr, returncode: r.returncode, timeMs: r.timeMs, memoryKb: r.memoryKb });
}

// ---------- 通信题协议归一化与包装层生成（two-phase 泛化：按签名生成 wrapper） ----------
// 类型菜单：参数 string / int / long long / vector<int>；返回 string / int / long long。
// ABI 约定：int 走 ccall "number"；long long 走十进制字符串（wrapper strtoll / std::to_string
//   转换，64 位全精度，绕开 JS number 的 2^53 精度上限）；string 走 char*（wrapper 转 std::string，
//   返回时用静态缓冲 __weboj_sbuf 的 c_str）；vector<int> 走 int* 缓冲区 + 长度（wrapper 转
//   std::vector<int>）。返回 string / long long 的 wrapper 返回 const char*，JS 侧 UTF8ToString 读取。

const RET_TYPES = new Set(["string", "int", "long long"]);

function toBigInt(v, def) {
  try { return BigInt(String(v == null ? def : v)); } catch (e) { return BigInt(def); }
}

// 新旧式协议归一化：fn1 / fn2 可为字符串（旧式，默认签名 fn1(string)→int、fn2(string,int)→int，
// X 为第二参）或对象 { name, params, ret }（新式声明完整签名；fn2 另带 xParam 表示 X 在参数中的下标）。
function normalizeTwoPhase(protocol) {
  protocol = protocol || {};
  let fn1, fn2;
  if (typeof protocol.fn1 === "object" && protocol.fn1) {
    fn1 = {
      name: protocol.fn1.name || "Alice",
      params: Array.isArray(protocol.fn1.params) ? protocol.fn1.params : ["string"],
      ret: RET_TYPES.has(protocol.fn1.ret) ? protocol.fn1.ret : "int",
    };
  } else {
    fn1 = { name: protocol.fn1 || "Alice", params: ["string"], ret: "int" };
  }
  if (typeof protocol.fn2 === "object" && protocol.fn2) {
    fn2 = {
      name: protocol.fn2.name || "Bob",
      params: Array.isArray(protocol.fn2.params) ? protocol.fn2.params : ["string", "int"],
      xParam: Number.isInteger(protocol.fn2.xParam) ? protocol.fn2.xParam : 1,
      ret: RET_TYPES.has(protocol.fn2.ret) ? protocol.fn2.ret : "int",
    };
  } else {
    fn2 = { name: protocol.fn2 || "Bob", params: ["string", "int"], xParam: 1, ret: "int" };
  }
  if (fn2.xParam < 0 || fn2.xParam >= fn2.params.length) fn2.xParam = fn2.params.length - 1;
  return {
    driver: "two-phase",
    fn1,
    fn2,
    xMax: toBigInt(protocol.xMax, 1048575),
    maxIntermediateBytes: Number(protocol.maxIntermediateBytes) || 1024,
    mutate: (protocol.mutate && typeof protocol.mutate === "object") ? protocol.mutate : null,
  };
}

function cppType(t) {
  return t === "string" ? "std::string" : t === "vector<int>" ? "std::vector<int>" : t;
}

// 生成单个函数的 extern "C" wrapper（把 ABI 参数转成 C++ 参数后调用户函数）
function buildWrapper(name, params, ret) {
  const cppParams = params.map((t, i) => `${cppType(t)} a${i}`).join(", ");
  const abiParams = [];
  const callArgs = [];
  for (let i = 0; i < params.length; i++) {
    const t = params[i];
    if (t === "string") {
      abiParams.push(`const char* a${i}`);
      callArgs.push(`a${i} ? std::string(a${i}) : std::string()`);
    } else if (t === "int") {
      abiParams.push(`int a${i}`);
      callArgs.push(`a${i}`);
    } else if (t === "long long") {
      abiParams.push(`const char* a${i}`);
      callArgs.push(`a${i} ? strtoll(a${i}, nullptr, 10) : 0`);
    } else if (t === "vector<int>") {
      abiParams.push(`const int* a${i}, int a${i}_len`);
      callArgs.push(`std::vector<int>(a${i}, a${i} + a${i}_len)`);
    }
  }
  const call = `${name}(${callArgs.join(", ")})`;
  let body;
  if (ret === "int") body = `    return ${call};`;
  else if (ret === "long long") body = `    __weboj_sbuf = std::to_string(${call});\n    return __weboj_sbuf.c_str();`;
  else body = `    __weboj_sbuf = ${call};\n    return __weboj_sbuf.c_str();`;
  return {
    decl: `${cppType(ret)} ${name}(${cppParams})`,
    abiRet: ret === "int" ? "int" : "const char*",
    abiParamsStr: abiParams.length ? abiParams.join(", ") : "void",
    body,
  };
}

function generateTwoPhaseWrapper(proto) {
  const w1 = buildWrapper(proto.fn1.name, proto.fn1.params, proto.fn1.ret);
  const w2 = buildWrapper(proto.fn2.name, proto.fn2.params, proto.fn2.ret);
  return (
    "#include <string>\n#include <vector>\n#include <cstdlib>\n\n" +
    `${w1.decl};\n${w2.decl};\n\n` +
    "static std::string __weboj_sbuf;\n\n" +
    "extern \"C\" {\n" +
    `  ${w1.abiRet} oj_${proto.fn1.name}(${w1.abiParamsStr}) {\n${w1.body}\n  }\n` +
    `  ${w2.abiRet} oj_${proto.fn2.name}(${w2.abiParamsStr}) {\n${w2.body}\n  }\n` +
    "}\n\n"
  );
}

// 按声明类型把 JS 值转成 ccall 参数（vector<int> 走 malloc 缓冲，调用后 freePtrs 释放）
function buildCallArgs(mod, params, values) {
  const types = [];
  const args = [];
  const ptrs = [];
  for (let i = 0; i < params.length; i++) {
    const t = params[i];
    const v = values[i];
    if (t === "string") {
      types.push("string");
      args.push(v == null ? "" : String(v));
    } else if (t === "int") {
      types.push("number");
      args.push(Number(v) | 0);
    } else if (t === "long long") {
      types.push("string");
      args.push(v == null ? "0" : String(v));
    } else if (t === "vector<int>") {
      const arr = Array.isArray(v) ? v.map((x) => Number(x) | 0) : [];
      const ptr = mod._malloc(Math.max(arr.length, 1) * 4);
      mod.HEAP32.set(arr, ptr >> 2);
      types.push("number", "number");
      args.push(ptr, arr.length);
      ptrs.push(ptr);
    }
  }
  return { types, args, ptrs };
}

function callJudgeFn(mod, name, retType, argTypes, args) {
  if (retType === "int") return mod.ccall(name, "number", argTypes, args);
  // string / long long：wrapper 返回 char*（静态缓冲），UTF8ToString 读出
  const ptr = mod.ccall(name, "number", argTypes, args);
  return mod.UTF8ToString(ptr);
}

function freePtrs(mod, ptrs) {
  for (const p of ptrs) { try { mod._free(p); } catch (e) {} }
}

// 按声明类型解析测试数据的一行（string 取整行、int / long long 取整数、vector<int> 取空格分隔序列）
function parseTwoPhaseValue(type, line) {
  if (line === undefined) throw new Error("缺少参数值（输入行数不足）");
  const s = String(line);
  if (type === "string") return s;
  if (type === "int") {
    const t = s.trim();
    if (!/^-?\d+$/.test(t)) throw new Error(`参数类型 int 解析失败："${s}" 不是整数`);
    const n = Number(t);
    if (n < -2147483648 || n > 2147483647) throw new Error(`int 参数超出 32 位范围：${t}`);
    return n;
  }
  if (type === "long long") {
    const t = s.trim();
    if (!/^-?\d+$/.test(t)) throw new Error(`参数类型 long long 解析失败："${s}" 不是整数`);
    return t; // 保留十进制字符串，保证 64 位精度
  }
  if (type === "vector<int>") {
    const t = s.trim();
    const parts = t === "" ? [] : t.split(/\s+/);
    return parts.map((x) => {
      if (!/^-?\d+$/.test(x)) throw new Error(`vector<int> 参数解析失败："${x}" 不是整数`);
      return Number(x) | 0;
    });
  }
  throw new Error(`未知参数类型：${type}`);
}

// 测试数据格式：每行一个参数，依次 fn1 全部参数 → fn2 除 X 外的全部参数
function parseTwoPhaseInput(input, fn1params, fn2params, xParam) {
  const lines = String(input == null ? "" : input).replace(/\r/g, "").split("\n");
  let idx = 0;
  try {
    const fn1Values = fn1params.map((t) => parseTwoPhaseValue(t, lines[idx++]));
    const fn2Values = [];
    for (let i = 0; i < fn2params.length; i++) {
      if (i === xParam) { fn2Values.push(undefined); continue; }
      fn2Values.push(parseTwoPhaseValue(fn2params[i], lines[idx++]));
    }
    return { fn1Values, fn2Values };
  } catch (e) {
    return { error: "测试数据解析失败：" + e.message };
  }
}

// X 校验：int / long long 落在 [0, xMax]（long long 用 BigInt 比较）；string 长度 ≤ maxIntermediateBytes
function validateX(X, retType, xMax, maxIntermediateBytes) {
  if (retType === "int") {
    const n = Number(X);
    if (!Number.isInteger(n) || n < 0 || n > Number(xMax)) {
      return `fn1 返回 ${X}，超出协议范围 [0, ${xMax}]`;
    }
  } else if (retType === "long long") {
    let big;
    try { big = BigInt(X); } catch (e) { return `fn1 返回 ${X}，不是合法整数`; }
    if (big < 0n || big > xMax) return `fn1 返回 ${X}，超出协议范围 [0, ${xMax}]`;
  } else if (X.length > maxIntermediateBytes) {
    return `fn1 返回字符串长度 ${X.length}，超过 maxIntermediateBytes=${maxIntermediateBytes}`;
  }
  return null;
}

// 固定种子的伪随机数生成器（LCG），mutate 变换共用，保证评测可复现
function makeRng(seed) {
  let state = (Number(seed) || 1) >>> 0;
  return () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state / 0x80000000;
  };
}

// 中间值变换（mutate，可选）：grader 在把 X 传给 fn2 之前按协议对 X 做变换。
// noise-num：X 约定为空格分隔的数字串，每个数字按 ratio 概率替换成 [min,max] 内的随机数（噪声信道，如 P9165）。
// delete-edges：X 约定为空格分隔的边集（u1 v1 u2 v2 ...），按 seed 随机删恰好 delete 条边（删边信道，如 P10539）。
function applyMutate(X, mutate) {
  if (!mutate) return X;
  if (typeof X !== "string") return X;
  const rand = makeRng(mutate.seed);
  if (mutate.type === "noise-num") {
    const ratio = Number(mutate.ratio) || 0;
    const min = Number(mutate.min) || 0;
    const max = Number(mutate.max) || 0;
    const parts = String(X).trim().split(/\s+/).filter((p) => p !== "");
    return parts
      .map((p) => (rand() < ratio ? String(min + Math.floor(rand() * (max - min + 1))) : p))
      .join(" ");
  }
  if (mutate.type === "delete-edges") {
    const del = Number(mutate.delete) || 0;
    const meta = Number(mutate.meta) || 0; // 前 meta 个数为元数据（不参与删边，原样保留在头部）
    const parts = String(X).trim().split(/\s+/).filter((p) => p !== "");
    if (parts.length <= meta) return X;
    const metaNums = parts.slice(0, meta);
    const edgeNums = parts.slice(meta);
    if (edgeNums.length < 2 || edgeNums.length % 2 !== 0) return X; // 非边集格式：原样传递
    const edges = [];
    for (let i = 0; i + 1 < edgeNums.length; i += 2) edges.push([edgeNums[i], edgeNums[i + 1]]);
    if (del >= edges.length) return metaNums.join(" "); // 全删（协议校验保证 delete < 边数）
    const removed = new Set();
    while (removed.size < del) removed.add(Math.floor(rand() * edges.length));
    const kept = edges.filter((_e, i) => !removed.has(i)).flat();
    return metaNums.concat(kept).join(" ");
  }
  return X;
}

function fmtArg(v) {
  if (typeof v === "string") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.join(", ") + "]";
  return String(v);
}

// 通信题编译：输出 MODULARIZE 工厂（可多次实例化），导出协议 wrapper 供 ccall 调用。
// 与普通题差异：-sMODULARIZE=1 -sEXPORT_NAME=JudgeModule、去掉 -sEXIT_RUNTIME=1、
// 加 -sEXPORTED_FUNCTIONS 导出函数。仍走 SINGLE_FILE 内嵌 wasm。
// ABI 对接：wrapper 按协议声明签名自动生成（见上 generateTwoPhaseWrapper）；命名约定：
// C 函数名 oj_fn（不带前导下划线），EXPORTED_FUNCTIONS 写 _oj_fn，ccall 写 oj_fn。
async function compileCommunication(sourceCode, memoryLimitMb, protocol) {
  // 按 protocol.driver 分流：stations 走数组 ABI 的专用 wrapper（见 compileStations）
  if (protocol && protocol.driver === "stations") {
    return compileStations(sourceCode, memoryLimitMb, protocol);
  }
  const proto = normalizeTwoPhase(protocol);
  const t0 = performance.now();
  const wrapper = generateTwoPhaseWrapper(proto);
  fs.writeFile("/working/main.cpp", wrapper + sourceCode);
  ensureStdCppHeader();
  const limitBytes = Math.max(memoryLimitMb || 64, 20) * 1024 * 1024; // 题限（下限 20MB）
  // 内存口径：INITIAL_MEMORY 直接设为题限、不 ALLOW_MEMORY_GROWTH，初始堆即上限，
  // malloc 超题限立即失败（抛 std::bad_alloc，stderr 带特征串按 MLE 判定）。
  // 注意：HEAPU8.length 因此恒等于题限，不能拿它当「堆顶已逼近上限」的兜底——
  // 该兜底恒真，会把一切运行时崩溃误判成 MLE（2026-08-25 走查 B8 空返回应判 RE 却判 MLE 暴露）。
  const compile = emrun(
    "em++", "-O2", "-fexceptions",
    "-sSINGLE_FILE=1",
    "-sMODULARIZE=1", "-sEXPORT_NAME='JudgeModule'",
    "-sEXPORTED_FUNCTIONS=['_oj_" + proto.fn1.name + "','_oj_" + proto.fn2.name + "','_malloc','_free']",
    "-sEXPORTED_RUNTIME_METHODS=['ccall','cwrap','stringToUTF8','UTF8ToString','lengthBytesUTF8']",
    "-sINITIAL_MEMORY=" + limitBytes, "-sTOTAL_STACK=2097152",
    "-std=c++17", "-I/working",
    "main.cpp", "-o", "main.js"
  );
  const timeMs = Math.round(performance.now() - t0);
  if (compile.returncode !== 0) {
    return { ok: false, errText: (compile.stderr || compile.stdout || "编译失败").slice(0, 4000), timeMs };
  }
  return { ok: true, mainJs: fs.readFile("/working/main.js", { encoding: "utf8" }), timeMs };
}

// 通信题编译（driver: stations，P6838 [IOI 2020] 网络站点）：与 two-phase 的差异仅在 ABI
// 约定——label 的返回值是数组（ccall 无法返回数组，改为 out 参数：JS 预分配 n 个 int，
// oj_label 写入后由 JS 经 HEAP32 读回；返回长度 ≠ n 时打印原因并 abort → RE）；u/v/c 数组
// 经 int* 缓冲区传入（JS 用 _malloc + HEAP32 填数），wrapper 内转 std::vector<int>。
// 其余编译参数与 two-phase 完全一致（MODULARIZE + 无 EXIT_RUNTIME + INITIAL_MEMORY=题限）。
async function compileStations(sourceCode, memoryLimitMb, protocol) {
  const t0 = performance.now();
  const fn1 = (protocol && protocol.fn1) || "label";
  const fn2 = (protocol && protocol.fn2) || "find_next_station";
  // 前置声明用户协议函数（保持 C++ 链接，wrapper 内以 C++ 方式调用）；
  // 再注入 extern "C" wrapper（C 函数名 oj_*，EXPORTED_FUNCTIONS 写 _oj_*，ccall 写 oj_*）。
  const wrapper = `#include <vector>\n` +
    `#include <cstdio>\n` +
    `#include <cstdlib>\n\n` +
    `std::vector<int> ${fn1}(int n, int k, std::vector<int> u, std::vector<int> v);\n` +
    `int ${fn2}(int s, int t, std::vector<int> c);\n\n` +
    `extern "C" {\n` +
    `  void oj_${fn1}(int n, int k, const int* u, const int* v, int* out) {\n` +
    `    std::vector<int> L = ${fn1}(n, k, std::vector<int>(u, u + n - 1), std::vector<int>(v, v + n - 1));\n` +
    `    if ((int)L.size() != n) {\n` +
    `      fprintf(stderr, "${fn1} 返回长度 %d，期望 %d\\n", (int)L.size(), n);\n` +
    `      abort();\n` +
    `    }\n` +
    `    for (int i = 0; i < n; i++) out[i] = L[i];\n` +
    `  }\n` +
    `  int oj_${fn2}(int s, int t, const int* c, int clen) {\n` +
    `    return ${fn2}(s, t, std::vector<int>(c, c + clen));\n` +
    `  }\n` +
    `}\n\n`;
  fs.writeFile("/working/main.cpp", wrapper + sourceCode);
  ensureStdCppHeader();
  const limitBytes = Math.max(memoryLimitMb || 64, 20) * 1024 * 1024; // 题限（下限 20MB）
  const compile = emrun(
    "em++", "-O2", "-fexceptions",
    "-sSINGLE_FILE=1",
    "-sMODULARIZE=1", "-sEXPORT_NAME='JudgeModule'",
    "-sEXPORTED_FUNCTIONS=['_oj_" + fn1 + "','_oj_" + fn2 + "','_malloc','_free']",
    "-sEXPORTED_RUNTIME_METHODS=['ccall','cwrap','stringToUTF8','UTF8ToString','lengthBytesUTF8']",
    "-sINITIAL_MEMORY=" + limitBytes, "-sTOTAL_STACK=2097152",
    "-std=c++17", "-I/working",
    "main.cpp", "-o", "main.js"
  );
  const timeMs = Math.round(performance.now() - t0);
  if (compile.returncode !== 0) {
    return { ok: false, errText: (compile.stderr || compile.stdout || "编译失败").slice(0, 4000), timeMs };
  }
  return { ok: true, mainJs: fs.readFile("/working/main.js", { encoding: "utf8" }), timeMs };
}

// 实例化通信题编译产物：new Function 执行 main.js 并 return 出 JudgeModule 工厂，再 new 实例。
// 每个实例有独立堆与全局状态（严格两进程语义）。
async function instantiateJudge(mainJs, onStderr) {
  if (!globalThis.document) globalThis.document = { currentScript: null };
  const factory = new Function(mainJs + "\nreturn JudgeModule;")();
  if (typeof factory !== "function") {
    throw new Error("通信题编译产物未导出 JudgeModule 工厂（MODULARIZE 失败）");
  }
  // onStderr：可选回调，捕获实例运行期的 printErr/stderr（如 wrapper 的 abort 前提示）
  const mod = await factory({
    print: () => {},
    printErr: (...a) => { if (onStderr) onStderr(a.join(" ")); },
  });
  if (!mod || typeof mod.ccall !== "function") {
    throw new Error("通信题实例缺少 ccall（EXPORTED_RUNTIME_METHODS 未生效）");
  }
  return mod;
}

// 运行一组通信题测试：两次独立实例化，分别调用 fn1 与 fn2。
// 协议 two-phase（泛化）：X = fn1(其参数)；P = fn2(除 X 外的参数，X 在 xParam 位置)；比对 P 与 expectedOutput。
async function runCommunicationCase(mainJs, tc, protocol, memoryLimitMb) {
  // 按 protocol.driver 分流：stations 走内置 grader（见 runStationsCase）
  if (protocol && protocol.driver === "stations") {
    return runStationsCase(mainJs, tc, protocol, memoryLimitMb);
  }
  const t0 = performance.now();
  const proto = normalizeTwoPhase(protocol);
  const { fn1, fn2, xMax, maxIntermediateBytes } = proto;

  // 测试数据：每行一个参数，依次 fn1 全部参数 → fn2 除 X 外的全部参数（按声明类型解析）
  const parsed = parseTwoPhaseInput(tc.input, fn1.params, fn2.params, fn2.xParam);
  if (parsed.error) {
    return {
      returncode: 1, stdout: "", ok: false, stderr: parsed.error,
      timeMs: Math.round(performance.now() - t0), memoryKb: null,
    };
  }
  const expected = String(tc.expectedOutput ?? "").replace(/\n$/, "");

  let modA = null, modB = null;
  try {
    // 阶段一：fn1(...) → X（经 C 链接 wrapper oj_fn1 完成 ABI 转换）
    modA = await instantiateJudge(mainJs);
    const c1 = buildCallArgs(modA, fn1.params, parsed.fn1Values);
    const X = callJudgeFn(modA, "oj_" + fn1.name, fn1.ret, c1.types, c1.args);
    freePtrs(modA, c1.ptrs);
    const xErr = validateX(X, fn1.ret, xMax, maxIntermediateBytes);
    if (xErr) {
      return {
        returncode: 1, stdout: "", ok: false, stderr: xErr,
        timeMs: Math.round(performance.now() - t0),
        memoryKb: modA.HEAPU8 ? Math.round(modA.HEAPU8.length / 1024) : null,
      };
    }

    // 中间值变换（可选）：按协议对 X 做变换后再传给 fn2（如噪声信道，见 applyMutate）
    const Xmut = applyMutate(X, proto.mutate);

    // 阶段二：fn2(..., X, ...) → P（新实例，与 fn1 实例完全隔离）
    modB = await instantiateJudge(mainJs);
    const fn2Values = parsed.fn2Values.slice();
    fn2Values[fn2.xParam] = Xmut;
    const c2 = buildCallArgs(modB, fn2.params, fn2Values);
    const P = callJudgeFn(modB, "oj_" + fn2.name, fn2.ret, c2.types, c2.args);
    freePtrs(modB, c2.ptrs);
    const Pstr = String(P);
    const ok = Pstr === expected;
    return {
      returncode: 0, stdout: Pstr, stderr: "", ok, X, P: Pstr,
      timeMs: Math.round(performance.now() - t0),
      memoryKb: modB.HEAPU8 ? Math.round(modB.HEAPU8.length / 1024) : null,
    };
  } catch (ex) {
    // MLE 按 stderr 特征串识别（与普通题口径一致）。不用「HEAPU8.length ≥ 90% 题限」兜底：
    // 通信题编译固定 -sINITIAL_MEMORY=题限，HEAPU8.length 恒等于题限，该兜底恒真、
    // 会把一切运行时崩溃误判成 MLE（2026-08-25 走查 B8 暴露）；OOM 场景自带
    // out of memory / bad_alloc / cannot enlarge memory 等特征串，特征串足以覆盖。
    const heapBytes = (modB && modB.HEAPU8 && modB.HEAPU8.length)
      || (modA && modA.HEAPU8 && modA.HEAPU8.length) || 0;
    const stack = String((ex && ex.stack) || ex);
    const oom = isOom(stack);
    return {
      returncode: 1, stdout: "", ok: false,
      stderr: stack,
      oom,
      timeMs: Math.round(performance.now() - t0),
      memoryKb: heapBytes ? Math.round(heapBytes / 1024) : null,
    };
  }
}

// ---------- 通信题 driver：stations（P6838 [IOI 2020] 网络站点） ----------
// 与官方评测模型对应：程序运行两次、全局状态互不可见，等价于每组数据两次独立实例化——
// 实例 A 只调 label（编号方案经 out 参数读回、保存在本 worker JS 侧），实例 B 以保存的编号
// 逐查询调用 find_next_station。判定由内置 grader 完成（非输出比对，expectedOutput 弃用）：
// ①编号合法（互不相同、∈[0,k]）；②逐查询与 BFS 算出的正确下一跳编号一致；首错即停。

// 测试数据格式（官方样例评测器格式的 r=1 特化）：
//   n k\n（u v）× (n-1)\nq\n（z y）× q
function parseStationsInput(input) {
  const nums = String(input ?? "").trim().split(/\s+/).map(Number);
  let p = 0;
  const n = nums[p++];
  const k = nums[p++];
  if (!Number.isInteger(n) || !Number.isInteger(k) || n < 2 || k < 0) {
    throw new Error("stations 测试数据格式错误（首行应为 n k）");
  }
  const edges = [];
  const adj = Array.from({ length: n }, () => []);
  for (let i = 0; i < n - 1; i++) {
    const u = nums[p++], v = nums[p++];
    if (!Number.isInteger(u) || !Number.isInteger(v) || u < 0 || v < 0 || u >= n || v >= n || u === v) {
      throw new Error(`stations 测试数据第 ${i + 1} 条边非法`);
    }
    edges.push([u, v]);
    adj[u].push(v);
    adj[v].push(u);
  }
  const q = nums[p++];
  if (!Number.isInteger(q) || q < 0) {
    throw new Error("stations 测试数据格式错误（查询数 q）");
  }
  const queries = [];
  for (let i = 0; i < q; i++) {
    const z = nums[p++], y = nums[p++];
    if (!Number.isInteger(z) || !Number.isInteger(y) || z < 0 || y < 0 || z >= n || y >= n || z === y) {
      throw new Error(`stations 测试数据第 ${i + 1} 个查询非法（z≠y 且均在 [0, n-1]）`);
    }
    queries.push([z, y]);
  }
  return { n, k, edges, adj, queries };
}

// 树上 BFS 求 z→y 的下一跳站点 w（y 是 z 的邻居时 w = y）
function bfsNext(adj, z, y) {
  const prev = new Array(adj.length).fill(-1);
  prev[z] = z;
  const queue = [z];
  for (let head = 0; head < queue.length; head++) {
    const u = queue[head];
    if (u === y) break;
    for (const w of adj[u]) {
      if (prev[w] === -1) {
        prev[w] = u;
        queue.push(w);
      }
    }
  }
  let cur = y;
  while (prev[cur] !== z) cur = prev[cur];
  return cur;
}

// 运行一组 stations 测试。返回：returncode 0 表示程序本身运行正常（WA 也走这里，ok:false +
// message 为明细文案）；非 0 为 RE/MLE（oom 标志区分）。r.L/r.m/r.qr 供自定义运行展示。
async function runStationsCase(mainJs, tc, protocol, memoryLimitMb) {
  const t0 = performance.now();
  const fn1 = protocol.fn1 || "label";
  const fn2 = protocol.fn2 || "find_next_station";

  const { n, k, edges, adj, queries } = parseStationsInput(tc.input);

  const qr = []; // 逐查询明细：[{z, y, s, t, c, rv, expected}]
  let L = null;  // label 返回的编号方案（WA 明细与自定义运行展示用）
  const wa = (message, memoryKb) => ({
    returncode: 0, stdout: "", stderr: "", ok: false, message, L, qr,
    timeMs: Math.round(performance.now() - t0), memoryKb,
  });

  let modA = null, modB = null, errBuf = "";
  const capErr = (s) => { errBuf += s + "\n"; };
  try {
    // 阶段一：label(n,k,u,v) → L（新实例；编号方案经 out 参数读回，保存在本 worker JS 侧）
    modA = await instantiateJudge(mainJs, capErr);
    const edgeCount = n - 1;
    const uPtr = modA._malloc(edgeCount * 4);
    const vPtr = modA._malloc(edgeCount * 4);
    const outPtr = modA._malloc(n * 4);
    modA.HEAP32.set(edges.map((e) => e[0]), uPtr >> 2);
    modA.HEAP32.set(edges.map((e) => e[1]), vPtr >> 2);
    modA.ccall("oj_" + fn1, null, ["number", "number", "number", "number", "number"], [n, k, uPtr, vPtr, outPtr]);
    L = Array.from(modA.HEAP32.subarray(outPtr >> 2, (outPtr >> 2) + n));
    modA._free(uPtr); modA._free(vPtr); modA._free(outPtr);

    // 校验编号：互不相同且 ∈ [0,k]（违规判 WA，明细写原因）
    const pos = new Map();
    for (let i = 0; i < n; i++) {
      const x = L[i];
      const memKb = modA.HEAPU8 ? Math.round(modA.HEAPU8.length / 1024) : null;
      if (!Number.isInteger(x) || x < 0 || x > k) {
        return wa(`编号不合法：站点 ${i} 的编号为 ${x}，应在 [0, ${k}] 内`, memKb);
      }
      if (pos.has(x)) {
        return wa(`编号不合法：编号 ${x} 在站点 ${pos.get(x)} 与站点 ${i} 重复出现`, memKb);
      }
      pos.set(x, i);
    }
    const m = Math.max(...L);

    // 阶段二：逐查询 find_next_station(s, t, c)（新实例，与 label 实例完全隔离；
    // c 为当前站邻居编号升序，经 oj_find_next_station 的 int* 缓冲区传入）
    modB = await instantiateJudge(mainJs, capErr);
    for (let qi = 0; qi < queries.length; qi++) {
      const [z, y] = queries[qi];
      const s = L[z], t = L[y];
      const c = adj[z].map((w) => L[w]).sort((a, b) => a - b);
      const cPtr = modB._malloc(Math.max(c.length, 1) * 4);
      modB.HEAP32.set(c, cPtr >> 2);
      const rv = modB.ccall("oj_" + fn2, "number", ["number", "number", "number", "number"], [s, t, cPtr, c.length]);
      modB._free(cPtr);
      const expected = L[bfsNext(adj, z, y)];
      qr.push({ z, y, s, t, c, rv, expected });
      if (rv !== expected) {
        return wa(
          `第 ${qi + 1} 个查询错误：站点 ${z}→${y}（编号 ${s}→${t}，邻居编号 [${c.join(", ")}]）` +
            `应返回编号 ${expected}，实际返回 ${rv}`,
          modB.HEAPU8 ? Math.round(modB.HEAPU8.length / 1024) : null
        );
      }
    }

    return {
      returncode: 0, stdout: `${queries.length} 个查询全部正确，m=${m}`, stderr: "", ok: true,
      L, m, qr,
      timeMs: Math.round(performance.now() - t0),
      memoryKb: modB.HEAPU8 ? Math.round(modB.HEAPU8.length / 1024) : null,
    };
  } catch (ex) {
    // 与 two-phase 同一套口径：MLE 只按 stderr 特征串识别（HEAPU8.length 恒等于题限，
    // 「≥90% 题限」兜底恒真、会把崩溃误判成 MLE，2026-08-25 走查 B8 暴露后已去掉）；
    // 实例的 printErr 也收进 errBuf（如 wrapper 的「返回长度不符」abort 前提示），
    // 一并拼进 stderr 供明细展示。
    const heapBytes = (modB && modB.HEAPU8 && modB.HEAPU8.length)
      || (modA && modA.HEAPU8 && modA.HEAPU8.length) || 0;
    const stack = String((ex && ex.stack) || ex);
    const oom = isOom(stack) || isOom(errBuf);
    return {
      returncode: 1, stdout: "", ok: false,
      stderr: (errBuf ? errBuf + "\n" : "") + stack,
      oom, L, qr,
      timeMs: Math.round(performance.now() - t0),
      memoryKb: heapBytes ? Math.round(heapBytes / 1024) : null,
    };
  }
}

// 通信题自定义运行：编译 + 对用户输入单组运行（供题目页「运行代码」使用）。
// 协议与 runCustom 一致：run-compile-start → (run-compile-error | run-start → run-done) | run-error。
// 通信题无 stdin/stdout，把两阶段结果组织成可读文本作为 stdout 展示（X / P）。
async function runCommunicationCustom(task) {
  await ensureInit();
  const protocol = task.protocol || {};
  if (protocol.driver === "stations") {
    await runStationsCustom(task, protocol);
    return;
  }
  const proto = normalizeTwoPhase(protocol);
  const { fn1, fn2 } = proto;
  post({ type: "run-compile-start" });
  const built = await compileCommunication(task.sourceCode, task.memoryLimitMb, protocol);
  if (!built.ok) {
    post({ type: "run-compile-error", stderr: built.errText, timeMs: built.timeMs });
    return;
  }
  post({ type: "run-start" });
  const r = await runCommunicationCase(built.mainJs, { input: task.input, expectedOutput: task.expectedOutput }, protocol, task.memoryLimitMb);
  // 单组判定：运行出错 → MLE/RE；填了预期输出才判 AC/WA，否则 verdict 为 null（仅展示运行结果）
  let verdict = null;
  if (r.returncode !== 0) {
    verdict = (r.oom || isOom(r.stderr)) ? "MLE" : "RE";
  } else if (task.expectedOutput != null && task.expectedOutput !== "") {
    verdict = String(r.P) === String(task.expectedOutput).replace(/\n$/, "") ? "AC" : "WA";
  }
  // 两阶段结果拼成可读文本（输入按每行一个参数解析）
  const parsed = parseTwoPhaseInput(task.input, fn1.params, fn2.params, fn2.xParam);
  const fn2Vals = parsed.error ? [] : parsed.fn2Values.slice();
  if (!parsed.error) fn2Vals[fn2.xParam] = r.X;
  const stdout = r.returncode === 0
    ? (parsed.error
        ? `（输入解析失败：${parsed.error}）`
        : `${fn1.name}(${parsed.fn1Values.map(fmtArg).join(", ")}) → X = ${r.X}\n` +
          `${fn2.name}(${fn2Vals.map(fmtArg).join(", ")}) → P = ${r.P}`)
    : "";
  post({ type: "run-done", verdict, stdout, stderr: r.stderr, X: r.X, P: r.P, returncode: r.returncode, timeMs: r.timeMs, memoryKb: r.memoryKb });
}

// 通信题自定义运行（driver: stations）：编译 + 对用户输入（stations 数据格式）单组运行。
// 与 runCommunicationCustom 同一消息协议；无标准输出，把编号方案与逐查询结果（含 grader
// 的期望值对照）组织为可读文本作为 stdout 展示。
async function runStationsCustom(task, protocol) {
  const fn1 = protocol.fn1 || "label";
  post({ type: "run-compile-start" });
  const built = await compileCommunication(task.sourceCode, task.memoryLimitMb, protocol);
  if (!built.ok) {
    post({ type: "run-compile-error", stderr: built.errText, timeMs: built.timeMs });
    return;
  }
  post({ type: "run-start" });
  const r = await runStationsCase(built.mainJs, { input: task.input, expectedOutput: "" }, protocol, task.memoryLimitMb);
  // 单组判定：运行出错 → MLE/RE；其余为展示性结果，verdict 为 null（与 two-phase 自定义运行口径一致）
  let verdict = null;
  if (r.returncode !== 0) {
    verdict = (r.oom || isOom(r.stderr)) ? "MLE" : "RE";
  }
  let stdout = "";
  if (r.returncode === 0) {
    const parts = [];
    if (r.ok) parts.push(`${r.qr.length} 个查询全部正确，m=${r.m}`);
    if (r.L) parts.push(`${fn1} 编号方案（站点 0..n-1）：[${r.L.join(", ")}]`);
    r.qr.forEach((row, idx) => {
      parts.push(
        `查询 ${idx + 1}：站点 ${row.z}→${row.y}（编号 ${row.s}→${row.t}，邻居编号 [${row.c.join(", ")}]）` +
          `返回 ${row.rv}，期望 ${row.expected}${row.rv === row.expected ? "（正确）" : "（不一致）"}`
      );
    });
    if (!r.ok && r.message) parts.push(r.message);
    stdout = parts.join("\n");
  }
  post({ type: "run-done", verdict, stdout, stderr: r.stderr, returncode: r.returncode, timeMs: r.timeMs, memoryKb: r.memoryKb });
}

async function judge() {
  if (task.language !== "cpp") {
    post({ type: "error", message: "当前仅支持 C++（cpp）" });
    return;
  }
  await ensureInit();

  // 通信题：走两进程函数式评测
  if (task.isCommunication) {
    await judgeCommunication(task);
    return;
  }

  // 1) 编译
  post({ type: "compile-start" });
  const built = await compileCpp(task.sourceCode, task.memoryLimitMb);
  post({ type: "compile-done", tookMs: built.timeMs });
  if (!built.ok) {
    // CE：details 直接存编译错误文本（提交详情页按字符串渲染日志行）
    post({ type: "done", verdict: "CE", details: built.errText, timeMs: built.timeMs });
    return;
  }

  // 2) 逐组运行（首错即停，与外部评测机语义一致）
  const mainJs = built.mainJs;
  const cases = Array.isArray(task.testcases) ? task.testcases : [];
  const details = [];
  let totalMs = 0; // 仅累计各组运行耗时（timeMs 口径 = 各组 wall-clock 之和）
  let maxMemoryKb = 0; // 各组 WASM 堆大小峰值（近似，当前口径 INITIAL_MEMORY=题限，恒=题限）
  let verdict = "AC";

  // 首错即停：剩余组补 ok:false、actualOutput:""（与外部评测机明细形状一致）
  const fillRest = (fromIdx) => {
    for (let i = fromIdx + 1; i < cases.length; i++) {
      details.push(caseDetail(cases[i], false, ""));
    }
  };

  for (let i = 0; i < cases.length; i++) {
    const tc = cases[i];
    post({ type: "case-start", ordinal: tc.ordinal, total: cases.length });
    const r = await runCase(mainJs, tc.input);
    totalMs += r.timeMs;
    if (r.memoryKb) maxMemoryKb = Math.max(maxMemoryKb, r.memoryKb);

    if (r.returncode !== 0) {
      verdict = isOom(r.stderr) ? "MLE" : "RE";
      // 附 main.js 头部诊断片段：若为胶水启动期错误，可直接定位出错行
      const runLog = (r.stderr || r.stdout || "").slice(0, 800);
      const detail = runLog + "\n[main.js 前 300 字符]\n" + mainJs.slice(0, 300) + "\n[worker v5]";
      details.push(caseDetail(tc, false, detail.slice(0, 1000)));
      fillRest(i);
      post({ type: "case-done", ordinal: tc.ordinal, ok: false, actualOutput: detail.slice(0, 1000), timeMs: r.timeMs });
      post({ type: "done", verdict, details, timeMs: totalMs, memoryKb: maxMemoryKb || null });
      return;
    }

    const ok = normalize(r.stdout) === normalize(tc.expectedOutput);
    details.push(caseDetail(tc, ok, r.stdout.slice(0, 500)));
    post({ type: "case-done", ordinal: tc.ordinal, ok, actualOutput: r.stdout.slice(0, 500), timeMs: r.timeMs });
    if (!ok) {
      verdict = "WA";
      fillRest(i);
      post({ type: "done", verdict, details, timeMs: totalMs, memoryKb: maxMemoryKb || null });
      return;
    }
  }

  post({ type: "done", verdict, details, timeMs: totalMs, memoryKb: maxMemoryKb || null });
}

// 通信题评测主流程：编译 → 逐组两进程运行（首错即停）
async function judgeCommunication(task) {
  const protocol = task.protocol || {};
  post({ type: "compile-start" });
  const built = await compileCommunication(task.sourceCode, task.memoryLimitMb, protocol);
  post({ type: "compile-done", tookMs: built.timeMs });
  if (!built.ok) {
    post({ type: "done", verdict: "CE", details: built.errText, timeMs: built.timeMs });
    return;
  }

  const mainJs = built.mainJs;
  const cases = Array.isArray(task.testcases) ? task.testcases : [];
  const details = [];
  let totalMs = 0;
  let maxMemoryKb = 0; // 各组 WASM 堆大小峰值（近似，当前口径 INITIAL_MEMORY=题限，恒=题限）
  let verdict = "AC";

  const fillRest = (fromIdx) => {
    for (let i = fromIdx + 1; i < cases.length; i++) {
      details.push(caseDetail(cases[i], false, ""));
    }
  };

  for (let i = 0; i < cases.length; i++) {
    const tc = cases[i];
    post({ type: "case-start", ordinal: tc.ordinal, total: cases.length });
    const r = await runCommunicationCase(mainJs, tc, protocol, task.memoryLimitMb);
    totalMs += r.timeMs;
    if (r.memoryKb) maxMemoryKb = Math.max(maxMemoryKb, r.memoryKb);

    if (r.returncode !== 0) {
      verdict = (r.oom || isOom(r.stderr)) ? "MLE" : "RE";
      const runLog = (r.stderr || "").slice(0, 800);
      details.push(caseDetail(tc, false, runLog.slice(0, 1000)));
      fillRest(i);
      post({ type: "case-done", ordinal: tc.ordinal, ok: false, actualOutput: runLog.slice(0, 1000), timeMs: r.timeMs });
      post({ type: "done", verdict, details, timeMs: totalMs, memoryKb: maxMemoryKb || null });
      return;
    }

    if (!r.ok) {
      verdict = "WA";
      // two-phase：返回 P 与期望比对；stations：内置 grader 的明细文案（r.message）
      const runLog = (r.message || `返回 ${r.P}，期望 ${tc.expectedOutput}`).slice(0, 1000);
      details.push(caseDetail(tc, false, runLog));
      fillRest(i);
      post({ type: "case-done", ordinal: tc.ordinal, ok: false, actualOutput: runLog, timeMs: r.timeMs });
      post({ type: "done", verdict, details, timeMs: totalMs, memoryKb: maxMemoryKb || null });
      return;
    }

    details.push(caseDetail(tc, true, r.stdout.slice(0, 500)));
    post({ type: "case-done", ordinal: tc.ordinal, ok: true, actualOutput: r.stdout.slice(0, 500), timeMs: r.timeMs });
  }

  post({ type: "done", verdict, details, timeMs: totalMs, memoryKb: maxMemoryKb || null });
}

self.onmessage = async (e) => {
  const msg = e.data || {};
  if (msg.type === "start" && msg.task) {
    task = msg.task;
    try {
      await judge();
    } catch (err) {
      post({ type: "error", message: String((err && err.stack) || err) });
    }
  } else if (msg.type === "run" && msg.task) {
    try {
      if (msg.task.isCommunication) {
        await runCommunicationCustom(msg.task);
      } else {
        await runCustom(msg.task);
      }
    } catch (err) {
      post({ type: "run-error", message: String((err && err.stack) || err) });
    }
  }
};
