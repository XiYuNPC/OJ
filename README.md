# WebOJ —— Web 端在线评测系统

浏览器内编译运行 C++（纯前端 WASM）+ 两进程函数式通信题的在线评测系统。技术栈：Node.js（Express + SQLite）+ 纯前端 C++ WASM + WebSocket 实时推送。

## 环境要求

- Node.js ≥ 23.4（推荐 24+；数据库使用 Node 内置的 `node:sqlite`，无原生编译依赖，无需 Visual Studio 等工具链）

## 一键启动

```bash
npm install
npm run seed     # 可选：注入演示数据（幂等，重复执行不会重复插入）
npm start        # 启动 http://localhost:3000
```

启动后：

- 前端页面：http://localhost:3000（题库首页；提交记录全局可见、按时间倒序，题目页可查看本题全部提交；代码公开性由提交者设置，未公开时他人仅见评测结果）
- 接口文档：http://localhost:3000/api/docs
- 演示会员账号：`demo / demo123`
- 演示管理员账号：`admin / admin123`
- 样例题目：A+B Problem（4 组测试数据，含 int 溢出边界）、P12509 通信题（两进程函数式：实现 Alice/Bob 两个函数，两次独立运行）

## 评测机模拟调用

评测机凭证首次启动自动生成于 `data/.judge-key`（也可用环境变量 `JUDGE_API_KEY` 指定）。用脚本 / Postman 模拟评测机：

1. 任务拉取（FIFO，拉取即置「评测中」）：
   ```bash
   curl -H "x-judge-key: <data/.judge-key 内容>" http://localhost:3000/api/judge/tasks
   ```
2. 结果回传（verdict 取 AC / WA / TLE / MLE / RE / CE 之一）：
   ```bash
   curl -X POST -H "x-judge-key: <key>" -H "Content-Type: application/json" \
     -d '{"submissionId":1,"verdict":"AC","details":[],"timeMs":12,"memoryKb":1024}' \
     http://localhost:3000/api/judge/results
   ```

## 浏览器内评测（纯前端评测机）

登录后提交代码，评测在**提交者浏览器内**完成：提交详情页 / 提交记录页会自动认领本人待评测提交（自助通道 `/api/judge/self/claim`），在 Web Worker 中先用 WASM 工具链（[emception](https://www.npmjs.com/package/emception)，静态托管于 `/vendor/emception/*`）执行 `em++` 编译，再在 worker 的真实浏览器 V8 里直接执行编译产物（`new Function` 注入 `Module`，逐组注入输入运行 + 比对输出；绕开 emception 的 quicknode，其为 WASM 版 node、无法实例化编译出的 wasm 模块），结果经 `/api/judge/self/results` 回传后对所有人可见。

- 首次评测需下载解压工具链（约几十 MB，IndexedDB 缓存于浏览器），此后明显加快；
- 支持 `bits/stdc++.h` 万能头（emscripten 用 libc++ 不提供该头，由评测机按 sysroot 实际头文件合成注入）；语言口径 C++17，C++20 专属特性不支持；
- 超时（TLE）由页面主线程 watchdog 强杀评测 worker；中断 / 异常时提交保持「评测中」，重新进入页面自动恢复；
- 判题近似口径（TLE 墙钟 + 3s 裕量、通信题 + 6s、MLE 内存上限识别等）见接口文档。

## 通信题评测（两进程函数式）

通信题（`is_communication=1`，示例 P12509）是项目核心，采用「严格两进程 + 纯函数式」评测，全程在浏览器内完成：

- **协议**：由题目的 `protocol` JSON 配置（`fn1`/`fn2` 函数名、`xMax` 中间值上限）。默认 `fn1=Alice`、`fn2=Bob`；
- **函数签名**：`int Alice(std::string S)`、`int Bob(std::string T, int X)`；
- **评测流程**：每组数据「两次独立实例化」编译产物（严格两进程、全局状态互不可见）——先调用 `Alice(S)` 得中间值 `X`（须落在 `[0, xMax]`，越界判 RE），再以 `X` 为参数调用 `Bob(T, X)` 得最终输出 `P`，与期望比对；
- **测试数据约定**：`input` 为 `"S\nT\n"` 两行，`expectedOutput` 为期望的 `P`；
- **ABI 对接**：编译时注入 C 链接 wrapper，把 `ccall` 的 `char*` 自动转 `std::string`——用户函数签名保持 C++ 的 `std::string` 即可，无需手写 `extern "C"`；
- **判定**：CE（编译失败/缺函数/签名不符）、WA（`P` 不符）、RE（中间值越界 / 运行崩溃）、TLE / MLE 与普通题同一套近似口径（通信题 TLE 裕量 +6s）。

## 接口自测

```bash
npm test   # 内存数据库跑完整接口断言（当前 59 项），不污染演示数据
```

## 目录结构

```
public/                前端页面（原生 HTML+JS，Express 静态托管）
  index.html           题库首页
  login.html           登录 / 注册
  problem.html         题目详情 + 在线提交
  submissions.html     提交记录
  submission.html      提交详情（终端式评测日志 + WebSocket 实时状态）
  admin.html           管理后台（题目 / 用户 / 提交）
  css/style.css        共享样式
  js/api.js            会话 / API 封装 / 导航 / toast / WS 工具
  js/admin.js          后台逻辑
  js/judge.js          浏览器内评测调度（认领 → worker → 超时强杀 → 回传）
  js/judge-worker.js   评测 worker（工具链编译 + 浏览器 V8 执行 + 逐组比对）
server/
  index.js             启动入口（HTTP + WebSocket）
  app.js               Express 应用组装（含 /vendor/emception 工具链静态托管）
  config.js            端口 / 数据库 / 密钥（自动生成）
  db.js                SQLite 初始化与表结构
  ws.js                WebSocket 状态推送（/ws?token=<JWT>）
  middleware/auth.js   JWT 解析 + RBAC 中间件
  routes/auth.js       注册 / 登录
  routes/problems.js   题目 CRUD / 测试数据 / 上下架 / 题解隐藏区
  routes/submissions.js 提交 / 列表 / 详情
  routes/judge.js      任务拉取 / 结果回传（x-judge-key 鉴权）+ 自助评测通道（JWT，仅限本人）
  routes/admin.js      用户列表 / 角色管理
  routes/docs.js       接口文档（程序化生成 /api/docs）
scripts/               脚本（npm run seed / npm test）
  seed.js              演示数据（幂等）
  test.js              接口自测脚本
docs/                  文档
  api.md               接口文档（Markdown 版，随代码维护）
  plan.md              立项书（第 1 天）
  第2天报告.md          组成与选型
  第3天报告.md          主路径数据与调用约定
  module-diagram.mermaid 系统模块图（mermaid 源码，与第 2 天报告一致）
```

## 状态与判定

评测状态机：`pending`（等待中）→ `judging`（评测中）→ `done`（完成，附 verdict）。

verdict：AC / WA / TLE / MLE / RE / CE。判题口径为近似：TLE 用 wall-clock（题限 + 3s 裕量、通信题 + 6s，主线程强杀 worker），MLE 用 WASM 内存上限（编译期 INITIAL_MEMORY 设为题限、下限 20MB，运行时 OOM abort 识别），逐组比对忽略行尾空白、首错即停（详见接口文档）。

## 进度

- [x] 第 1 天：立项书与验收标准（docs/plan.md）
- [x] 第 2 天：组成与选型（docs/第2天报告.md）；后端核心接口（36 项自测通过）；前端页面（题库 / 登录注册 / 提交与实时状态 / 管理后台）
- [x] 第 3 天：纯前端 C++ WASM 编译运行（emception 工具链 + 浏览器内评测 worker，自助评测通道）
- [x] 第 4 天：通信题评测（两进程函数式，wrapper 对接 std::string 参数，CE/TLE/MLE/RE/WA/AC 判定已实测）
