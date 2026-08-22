// judge-worker.js —— 浏览器内评测机（module 型 Web Worker）
// 技术栈：emception 1.0.15（WASM 版 clang/lld/python/quicknode 工具链）的底层组件，
//         通过相对路径 ESM 直接组装（emception.js 入口含 webpack 别名，无法在浏览器使用）。
// 评测流程：初始化工具链 → em++ 编译 main.cpp → 逐组注入 stdin 运行 main.js → 比对输出 → 回传结果。
//
// 判题口径（近似，与纯前端架构一致）：
//   TLE：本 worker 内执行是同步阻塞的，自身计时器无法触发，由页面主线程 watchdog 超时强杀实现；
//   MLE：编译期把 WASM 内存上限设为题目限制（下限 20MB），运行中 OOM abort 按 stderr 特征串识别；
//   timeMs 为 wall-clock 近似（含 WASM 启动开销），不统计内存（memoryKb 不回报）。
// 通信题（两进程函数式，P12509）：编译产物用 -sMODULARIZE=1 -sEXPORT_NAME='JudgeModule'
//   输出为工厂函数，每组数据「两次 new JudgeModule()」分别实例化协议 fn1 与 fn2 实例（严格两进程、
//   全局状态互不可见），fn1 返回的 X 由本 worker 在 JS 侧传递给 fn2 实例。编译前注入 C 链接
//   wrapper（C 函数名 oj_fn1/oj_fn2，负责 char*→std::string 转换，因 ccall 的 "string" 只能传
//   char*、无法直接对 std::string 按值传参）；EXPORTED_FUNCTIONS 用 _oj_fn1/_oj_fn2 指代它们，
//   ccall 用 oj_fn1/oj_fn2（不带前导下划线）。编译不加 -sEXIT_RUNTIME
//   （否则运行时退出后函数不可调），且因无 main，胶水不会自动 callMain。测试数据约定：input 为
//   "S\nT\n" 两行，expectedOutput 为期望 P。
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

// 通信题编译：输出 MODULARIZE 工厂（可多次实例化），导出协议 wrapper 供 ccall 调用。
// 与普通题差异：-sMODULARIZE=1 -sEXPORT_NAME=JudgeModule、去掉 -sEXIT_RUNTIME=1、
// 加 -sEXPORTED_FUNCTIONS 导出函数。仍走 SINGLE_FILE 内嵌 wasm。
// 关键点（ABI 对接）：用户按 C++ 习惯写 int fn(std::string)，但 ccall 的 "string" 参数只能
//   传 C 字符串(char*)，二者不匹配（std::string 按值传参在 C++ ABI 下非 char*）。因此注入
//   一组 C 链接 wrapper：C 函数名 oj_fn(const char*) / oj_fn(const char*, int)，内部构造
//   std::string 再调用户函数，ccall 只与 wrapper 的 char* 签名对接。注意命名约定：C 函数名
//   oj_fn（不带前导下划线），EXPORTED_FUNCTIONS 写 _oj_fn，ccall 写 oj_fn。
async function compileCommunication(sourceCode, memoryLimitMb, protocol) {
  const t0 = performance.now();
  const fn1 = (protocol && protocol.fn1) || "Alice";
  const fn2 = (protocol && protocol.fn2) || "Bob";
  // 前置声明用户协议函数（保持 C++ 链接，wrapper 内以 C++ 方式调用）；
  // 再注入 extern "C" wrapper，负责 char* -> std::string 转换。
  const wrapper = `#include <string>\n` +
    `int ${fn1}(std::string S);\n` +
    `int ${fn2}(std::string T, int X);\n\n` +
    `extern "C" {\n` +
    `  int oj_${fn1}(const char* S) { return ${fn1}(S ? std::string(S) : std::string()); }\n` +
    `  int oj_${fn2}(const char* T, int X) { return ${fn2}(T ? std::string(T) : std::string(), X); }\n` +
    `}\n\n`;
  fs.writeFile("/working/main.cpp", wrapper + sourceCode);
  ensureStdCppHeader();
  const limitBytes = Math.max(memoryLimitMb || 64, 20) * 1024 * 1024; // 题限（下限 20MB）
  // 内存口径：INITIAL_MEMORY 直接设为题限、不 ALLOW_MEMORY_GROWTH。这样初始堆即上限，
  // malloc 超题限立即失败（抛 std::bad_alloc），且失败时 HEAPU8.length 已等于题限，
  // 供 runCommunicationCase 的「堆大小 ≥ 题限×0.9」兜底把 MLE 从 RE 里区分出来。
  // （若用 16MB 起步 + grow，grow 失败时 HEAPU8 停留在初始值，堆大小兜底会失效。）
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
async function instantiateJudge(mainJs) {
  if (!globalThis.document) globalThis.document = { currentScript: null };
  const factory = new Function(mainJs + "\nreturn JudgeModule;")();
  if (typeof factory !== "function") {
    throw new Error("通信题编译产物未导出 JudgeModule 工厂（MODULARIZE 失败）");
  }
  const mod = await factory({ print: () => {}, printErr: () => {} });
  if (!mod || typeof mod.ccall !== "function") {
    throw new Error("通信题实例缺少 ccall（EXPORTED_RUNTIME_METHODS 未生效）");
  }
  return mod;
}

// 运行一组通信题测试：两次独立实例化，分别调用 fn1(Alice) 与 fn2(Bob)。
// 协议 two-phase：X = Alice(S)；P = Bob(T, X)；比对 P 与 expectedOutput。
async function runCommunicationCase(mainJs, tc, protocol, memoryLimitMb) {
  const t0 = performance.now();
  const fn1 = protocol.fn1 || "Alice";
  const fn2 = protocol.fn2 || "Bob";
  const xMax = Number(protocol.xMax) || 1048575;
  const maxMemBytes = Math.max(memoryLimitMb || 64, 20) * 1024 * 1024; // 与编译 -sINITIAL_MEMORY（题限）一致

  // 测试数据约定：input = "S\nT\n"（两行），expectedOutput = 期望 P
  const lines = String(tc.input ?? "").split("\n");
  const S = (lines[0] ?? "").trim();
  const T = (lines[1] ?? "").trim();
  const expected = String(tc.expectedOutput ?? "").replace(/\n$/, "");

  let modA = null, modB = null;
  try {
    // 阶段一：Alice(S) → X（经 C 链接 wrapper oj_fn1 完成 char*→std::string 转换）
    modA = await instantiateJudge(mainJs);
    const X = modA.ccall("oj_" + fn1, "number", ["string"], [S]);
    if (!Number.isFinite(X) || X < 0 || X > xMax) {
      return {
        returncode: 1, stdout: "", ok: false,
        stderr: `${fn1}(${JSON.stringify(S)}) 返回 ${X}，超出协议范围 [0, ${xMax}]`,
        timeMs: Math.round(performance.now() - t0),
        memoryKb: modA.HEAPU8 ? Math.round(modA.HEAPU8.length / 1024) : null,
      };
    }

    // 阶段二：Bob(T, X) → P（新实例，与 Alice 实例完全隔离；经 oj_fn2 转换）
    modB = await instantiateJudge(mainJs);
    const P = modB.ccall("oj_" + fn2, "number", ["string", "number"], [T, X]);
    const ok = String(P) === expected;
    return {
      returncode: 0, stdout: String(P), stderr: "", ok, X, P,
      timeMs: Math.round(performance.now() - t0),
      memoryKb: modB.HEAPU8 ? Math.round(modB.HEAPU8.length / 1024) : null,
    };
  } catch (ex) {
    // MLE 兜底：除 stderr 特征串外，若异常时 WASM 堆已逼近上限（≥90% MAXIMUM_MEMORY），
    // 也视为内存不足——避免 C++ new 抛 std::bad_alloc 等无 OOM 特征串的崩溃被误判成 RE。
    const heapBytes = (modB && modB.HEAPU8 && modB.HEAPU8.length)
      || (modA && modA.HEAPU8 && modA.HEAPU8.length) || 0;
    const stack = String((ex && ex.stack) || ex);
    const oom = isOom(stack) || (heapBytes > 0 && heapBytes >= maxMemBytes * 0.9);
    return {
      returncode: 1, stdout: "", ok: false,
      stderr: stack,
      oom,
      timeMs: Math.round(performance.now() - t0),
      memoryKb: heapBytes ? Math.round(heapBytes / 1024) : null,
    };
  }
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
      const runLog = `返回 ${r.P}，期望 ${tc.expectedOutput}`.slice(0, 1000);
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
      await runCustom(msg.task);
    } catch (err) {
      post({ type: "run-error", message: String((err && err.stack) || err) });
    }
  }
};
