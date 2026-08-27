# WebOJ —— Web 端在线评测系统

浏览器内编译运行 C++（纯前端 WASM）+ 后端多语言评测（C / Python / Java）+ 两进程函数式通信题的在线评测系统。技术栈：Node.js（Express + SQLite）+ 纯前端 C++ WASM + WebSocket 实时推送。

## 环境要求

- Node.js ≥ 23.4（推荐 24+；数据库使用 Node 内置的 `node:sqlite`，无原生编译依赖，无需 Visual Studio 等工具链）

## 一键启动

```bash
npm install
npm run seed     # 可选：注入演示数据（幂等，重复执行不会重复插入）
npm start        # 启动 http://localhost:3000
npm run daemon   # 可选：启动后端评测机（评测 C / Python / Java 提交；C++ 仍走浏览器内）
```

启动后：

- 前端页面：http://localhost:3000（题库首页；提交记录全局可见、按时间倒序，题目页可查看本题全部提交；代码公开性由提交者设置，未公开时他人仅见评测结果）
- 接口文档：http://localhost:3000/api/docs
- 演示会员账号：`demo / demo123`
- 演示管理员账号：`admin / admin123`
- 样例题目：A+B Problem（4 组测试数据，含 int 溢出边界）、P12509 通信题（two-phase：实现 Alice/Bob 两个函数，两次独立运行）、P6838 网络站点（stations：数组参数 + 内置 grader）、数组求和接力（two-phase 类型菜单：vector<int> 参数 + long long 返回）、B3790 文本压缩（two-phase：compress/decompress 两个函数）、P9165 意外（two-phase + mutate 噪声信道：encode/decode 抗噪编码）、P10539 魔术表演（two-phase + mutate 删边信道：alice/bob）
- 样例比赛：新手练习赛（进行中）、历史周赛 #1（已结束，含滚榜演示数据：8 名选手 40 条提交、4 道赛题，详情页可点「开始滚榜」重放）

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

## 多语言与后端评测机

- 支持语言：`cpp`（C++17，浏览器内实时编译）、`c`（C11，gcc）、`python`（Python 3）、`java`（Java，约定类名 `Main`）；
- 浏览器内实时编译（RUN/TEST 即时预览）**仅限 C++**；C / Python / Java 提交后由后端评测机处理；
- 后端评测机：`npm run daemon` 启动独立进程，轮询 `GET /api/judge/tasks?language=c,python,java` 拉取非浏览器语言任务，用系统编译器（gcc / python3 / javac）编译运行、逐组比对，回传 `POST /api/judge/results`；
- 判定口径：编译失败 → CE；进程超时强杀 → TLE；非零退出 → RE（stderr 含 `out of memory` 等判 MLE）；输出比对 → AC / WA；
- 安全边界：本地演示用途、非生产级沙箱（进程超时强杀 + 输出 1MB 截断 + 独立临时目录），请勿对不可信网络开放评测机端口。

## 通信题评测（两进程函数式）

通信题（`is_communication=1`，示例 P12509、P6838、B3790、P9165）是项目核心，采用「严格两进程 + 纯函数式」评测，全程在浏览器内完成，由题目 `protocol` 的 `driver` 字段选择驱动：

- **two-phase**（P12509 / 数组求和接力 / B3790 / P9165 / P10539）：协议泛化类型菜单——参数 `string` / `int` / `long long` / `vector<int>`，返回 `string` / `int` / `long long`；`fn1` / `fn2` 可为函数名字符串（旧式，默认 `int fn1(std::string)` / `int fn2(std::string, int)`，X 为第二参）或签名对象 `{name, params, ret}`（新式，fn2 另带 `xParam` 指定 X 位置）。每组数据「两次独立实例化」编译产物（严格两进程、全局状态互不可见）——先调用 fn1 得中间值 `X`（int/long long 须落在 `[0, xMax]`、string 长度 ≤ `maxIntermediateBytes`，越界判 RE），再以 `X` 为参数调用 fn2 得最终输出 `P`，与期望比对；测试数据约定：`input` 每行一个参数（依次 fn1 全部参数 → fn2 除 X 外参数），`expectedOutput` 为期望的 `P`；可选 `mutate`（中间值变换）：`noise-num`——X（空格分隔数字串）每数字按 `ratio` 概率替换成 `[min,max]` 随机数（P9165 噪声信道）；`delete-edges`——X（空格分隔边集 u1 v1 u2 v2 ...）按 `seed` 随机删恰好 `delete` 条边，可选 `meta`（前 meta 个数为元数据、不参与删边）（P10539 删边信道）；两者 `seed` 固定、评测可复现；
- **stations**（P6838 网络站点）：用户实现 `std::vector<int> label(int n, int k, std::vector<int> u, std::vector<int> v)`、`int find_next_station(int s, int t, std::vector<int> c)`。第一次实例化只调 `label`（编号方案经 out 参数读回、保存在评测机侧），第二次实例化用保存的编号逐查询调 `find_next_station`；判定由**内置 grader** 完成（不用 `expectedOutput`）——编号互不相同且 ∈ [0,k]，逐查询与评测机 BFS 算出的正确下一跳比对，首错即停，最大编号 m 写进 AC 明细；测试数据为官方样例评测器格式（`n k` / n-1 条边 / `q` / q 行 `z y`）；
- **ABI 对接**：编译时按签名生成 C 链接 wrapper——`int` 走 `ccall` 的 `"number"`；`long long` 走十进制字符串（`strtoll` / `std::to_string`，64 位全精度，绕开 JS `number` 的 2⁵³ 上限）；`char*` 自动转 `std::string`；`int*` 缓冲区转 `std::vector<int>`（数组返回走 out 参数，仅 stations）——用户函数签名保持 C++ 写法即可，无需手写 `extern "C"`；
- **判定**：CE（编译失败/缺函数/签名不符）、WA、RE（中间值越界 / 返回长度不符 / 运行崩溃）、TLE / MLE 与普通题同一套近似口径（通信题 TLE 裕量 +6s）。

## 比赛（独立提交 / 实时榜 / 赛后滚榜）

比赛是赛题集合 + 时间窗口，采用 ACM/ICPC 赛制：

- **独立提交**：从比赛详情点赛题进入 `/problem.html?id=&contestId=`，提交会校验「比赛存在、题目属于该比赛、比赛进行中（start ≤ now < end）」；非比赛提交（不带 `contestId`）不计入榜单；
- **实时榜**：`GET /api/contests/:id/scoreboard` 返回榜单（按 AC 数降序 → 罚时升序 → 最近 AC 时间升序）。罚时 = 各 AC 题首次 AC 用时分钟（向上取整）+ 首次 AC 前错误提交数 × 20（CE 不计错误次数）。比赛内提交评测完成时经 WebSocket 广播 `contest-scoreboard`，榜单页自动刷新；
- **封榜 + 赛后滚榜**：比赛可配封榜时间 `freezeTime`（后台可选，留空 = 不封榜）。封榜后的提交在榜单上冻结（显示 `+N` 冻结数）；比赛结束后详情页出现「开始滚榜」按钮，从封榜时刻的榜单开始，拖动进度条或逐条揭晓（按「当前排名从低到高」顺序），每揭晓一条重算一次排名，全部揭晓后 = 终榜；
- **详情页五标签**：首页（信息与简介）/ 题目 / 评测状态（本比赛全部提交，题号按 A、B、C… 显示）/ 排行榜 / 通知，当前标签写入 URL hash（刷新保持）；
- **比赛通知**：`GET/POST /api/contests/:id/announcements` 与 `PATCH/DELETE …/:aid`——公开读、仅管理员可发布/编辑/删除（比赛页内联操作），增删改经 WebSocket 广播 `contest-announcement` 实时推送到比赛页。

## 接口自测

```bash
npm test      # 内存数据库跑完整接口断言（当前 136 项），不污染演示数据
npm run stress # 后端接口高压测试（并发正确性 + 吞吐/延迟 + 稳定性，内存库）
npm run harness # harness 检查：扫描 docs/ 与 README 的仓库地址与密钥特征（规则见根目录 AGENTS.md）
npm run verify-p6838 # 通信题标号方案数据互验（枚举小树全查询，验证判别/路由与 BFS 一致）
npm run realdata # 真实数据只读回归（用 data/weboj.db 的真实提交，26 项断言，不写库）
```

## 目录结构

```
AGENTS.md              harness 约束套件（对人与 AI 助手同时生效的规则与核对办法）
public/                前端页面（原生 HTML+JS，Express 静态托管）
  index.html           题库首页
  login.html           登录 / 注册
  problem.html         题目详情 + 在线提交
  contests.html        比赛列表
  contest.html         比赛详情（首页 / 题目 / 评测状态 / 排行榜 / 通知五标签，实时榜 + 赛后滚榜）
  submissions.html     提交记录
  submission.html      提交详情（终端式评测日志 + WebSocket 实时状态）
  admin.html           管理后台（题目 / 比赛 / 用户 / 提交）
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
  routes/contests.js   比赛列表 / 详情 / 实时榜单 / CRUD（赛题关联）
  routes/submissions.js 提交 / 列表 / 详情
  routes/judge.js      任务拉取 / 结果回传（x-judge-key 鉴权）+ 自助评测通道（JWT，仅限本人）
  routes/admin.js      用户列表 / 角色管理
  routes/docs.js       接口文档（程序化生成 /api/docs）
scripts/               脚本（npm run seed / npm test / npm run stress / npm run daemon / npm run harness）
  seed.js              演示数据（幂等）
  test.js              接口自测脚本
  stress.js            后端接口高压测试
  harness-check.js     harness 检查（文档/报告敏感信息扫描）
  judge-daemon.js      后端评测机（gcc / python3 / javac 编译运行 C / Python / Java）
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
- [x] 第 2 天：组成与选型（docs/第2天报告.md）；后端核心接口；前端页面（题库 / 登录注册 / 提交与实时状态 / 管理后台）
- [x] 第 3 天：纯前端 C++ WASM 编译运行（emception 工具链 + 浏览器内评测 worker，自助评测通道）
- [x] 第 4 天：通信题评测（两进程函数式，wrapper 对接 std::string 参数，CE/TLE/MLE/RE/WA/AC 判定已实测）
- [x] 第 5 天：主路径贯通（真实浏览器内评测替换固定判定假实现、WS 推送替换轮询、TLE/MLE 近似口径定稿、压测 17 项）
- [x] 第 6 天：仓库 harness（AGENTS.md + harness-check）+ 比赛模块（五标签重构 + 通知系统）+ P6838 stations 通信题上线（driver 双轨）
- [x] 第 7 天：贯通验证与排错（验收 15 条全过；修复死循环 TLE 口径、P6838 深度判别、MLE 恒真兜底、实时榜 cells 形状四例）
- [ ] 第 8 天（进行中）：协议类型菜单定稿（two-phase 类型菜单 + long long 十进制字符串 ABI + 后台结构化表单 / JSON 双模式，已实现待浏览器走查）；剩余：harness 补强、比赛模块立项书修订、git 提交整理
