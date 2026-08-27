# WebOJ 接口文档（Markdown 版）

> 在线版：启动后访问 `GET /api/docs`（由 server/routes/docs.js 程序化生成，与本文档同源维护）。

## 鉴权说明

- 受保护接口使用请求头 `Authorization: Bearer <JWT>`；未登录返回 401，角色不足返回 403。
- 评测机接口使用请求头 `x-judge-key`（启动时自动生成于 `data/.judge-key`，或环境变量 `JUDGE_API_KEY`）；缺失或无效返回 401。
- 身份体系：游客（未登录）/ 会员（题库注册）/ 管理员（后台）。

## 评测状态机

```
pending（等待中） → judging（评测中） → done（完成，附 verdict）
```

verdict 取值：AC / WA / TLE / MLE / RE / CE。

## 判定口径（近似）

- TLE：以 wall-clock 近似判定——普通题每组运行超过「题限 + 3s WASM 启动裕量」、通信题「题限 + 6s」（通信题每组需两次实例化，裕量单独加大）由页面主线程强杀评测 worker；
- MLE：编译期把 WASM 内存上限设为题限（`INITIAL_MEMORY = max(题限, 20MB)`，不 `ALLOW_MEMORY_GROWTH`），运行中分配超限触发 OOM abort，按 stderr 特征串（`Aborted(OOM)` / `bad_alloc` / `out of memory` 等）识别（通信题与普通题同一套口径，不做「堆顶 ≥ 题限×0.9」兜底——INITIAL_MEMORY 恒等于题限会使该兜底恒真）；
- `timeMs` 为各组 wall-clock 耗时之和（近似值），`memoryKb` 为 WASM 堆大小近似（该口径下约等于题限，非实际峰值）；
- 输出比对：逐行忽略行尾空白、忽略末尾空行，首错即停（WA/TLE/MLE/RE 不再评测后续组，剩余组明细 `ok:false`、`actualOutput:""`）；
- 精确计时与内存测量不在本项目范围内。

## 通信题协议（两进程函数式）

通信题（`isCommunication=1`）每组数据两次独立实例化编译产物（严格两进程、全局状态互不可见），由题目 `protocol` JSON 的 `driver` 字段选择评测驱动：

| driver | 示例 | 用户函数签名（不写 main） | 中间值 | 判定 |
| --- | --- | --- | --- | --- |
| `two-phase` | P12509 / 数组求和接力 / B3790 / P9165 / P10539 | 按 `protocol` 类型菜单声明（见下） | fn1 返回标量 `X`（int/long long 须在 `[0, xMax]`，越界 RE；string 长度 ≤ `maxIntermediateBytes`；可经 `mutate` 变换，见下） | fn2 返回 `P` 与 `expectedOutput` 比对 |
| `stations` | P6838 网络站点 | `std::vector<int> fn1(int n, int k, std::vector<int> u, std::vector<int> v)`、`int fn2(int s, int t, std::vector<int> c)` | fn1 返回编号数组（经 out 参数读回，长度 ≠ n → RE） | 内置 grader：编号互不相同且 ∈ [0,k]；逐查询与 BFS 正确下一跳比对；最大编号 m 写入明细 |

**two-phase 类型菜单（协议泛化）**：`fn1` / `fn2` 可为字符串（旧式，走默认签名）或对象声明完整签名：

- 参数类型：`string` / `int` / `long long` / `vector<int>`（个数不限）；返回类型：`string` / `int` / `long long`；
- 新式写法：`fn1: { name, params, ret }`、`fn2: { name, params, xParam, ret }`——`xParam` 为 X 在 fn2 参数中的下标（0 起），X 类型 = fn1 返回 = `fn2.params[xParam]`；
- 旧式写法（直接写函数名）按默认签名处理：fn1 `(string)→int`、fn2 `(string,int)→int`（X 为第二参），与 P12509 历史数据兼容；
- ABI：编译时按签名生成 extern "C" wrapper——`int` 走 ccall `"number"`；`long long` 走十进制字符串（`strtoll` / `std::to_string` 转换，64 位全精度，绕开 JS `number` 的 2⁵³ 精度上限）；`string` 走 `char*`；`vector<int>` 走 `int*` 缓冲区 + 长度（数组返回走 out 参数，仅 stations 用）；用户无需手写 `extern "C"`；
- 测试数据：`two-phase` 的 `input` 每行一个参数（依次 fn1 全部参数 → fn2 除 X 外参数，按声明类型解析：`string` 取整行、`int`/`long long` 取整数、`vector<int>` 取空格分隔序列）、`expectedOutput` 为期望 P；`stations` 的 `input` 为官方样例评测器格式（`n k` / n-1 条边 / `q` / q 行 `z y`），`expectedOutput` 弃用；
- 中间值变换（`mutate`，可选）：grader 在把 X 传给 fn2 前按协议对 X 变换——`noise-num`（噪声信道）：X 约定为空格分隔的数字串，每个数字按 `ratio` 概率替换成 `[min, max]` 内的随机数；`delete-edges`（删边信道）：X 约定为空格分隔的边集（u1 v1 u2 v2 ...），按 `seed` 随机删恰好 `delete` 条边，可选 `meta`（前 `meta` 个数为元数据、不参与删边、原样保留在头部）；两者 `seed` 均固定驱动 LCG、评测可复现，且要求 fn1 返回类型为 string；
- 判定：CE（编译失败 / 缺函数 / 签名不符）、WA、RE（中间值越界 / 返回长度不符 / 运行崩溃）、TLE / MLE 与普通题同一套近似口径。

## 接口清单

### auth

| 方法 | 路径 | 说明 | 调用方 |
| --- | --- | --- | --- |
| POST | `/api/auth/register` | 题库注册（注册后即为会员），密码加盐哈希存储 | 公开（游客） |
| POST | `/api/auth/login` | 登录（会员 / 管理员同一入口），返回 JWT 与角色 | 公开 |

### problems

| 方法 | 路径 | 说明 | 调用方 |
| --- | --- | --- | --- |
| POST | `/api/problems` | 发布题目（题面、时空限制、题解隐藏区、≥3 组测试数据，少于 3 组拒绝保存） | 管理员 |
| GET | `/api/problems` | 题目列表（游客 / 会员只见已上架，管理员见全部） | 公开（可选登录） |
| GET | `/api/problems/:id` | 题目详情：会员含测试数据；题解按 `solutionVisible`；管理员含全部字段 | 公开（可选登录） |
| PATCH | `/api/problems/:id` | 编辑 / 上下架题目（提供 `testcases` 时整体替换） | 管理员 |

### submissions

| 方法 | 路径 | 说明 | 调用方 |
| --- | --- | --- | --- |
| POST | `/api/submissions` | 提交代码，生成评测任务（状态 pending；通信题同样可提交，评测走两进程函数式）；`language` 支持 `c` / `cpp` / `python` / `java`（cpp 浏览器内实时编译，其余走后端评测机；通信题强制 cpp）；`isPublic` 设置代码公开性（0/1，默认 1 公开）；`contestId` 表示比赛内提交（校验比赛存在、题目属于该比赛、比赛进行中，否则 400） | 会员 / 管理员 |
| GET | `/api/submissions` | 提交列表（最近 200 条，按提交时间倒序，含题目标题与提交者）；支持 `?problemId=` 只看某题、`?contestId=` 只看某比赛 | 公开（游客可见） |
| GET | `/api/submissions/:id` | 提交详情：评测结果人人可见；源代码仅本人 / 管理员 / 公开提交可见，未公开时 `sourceCode` 返回 `null` | 公开（游客可见） |

### contests

| 方法 | 路径 | 说明 | 调用方 |
| --- | --- | --- | --- |
| GET | `/api/contests` | 比赛列表（游客 / 会员只见公开，管理员见全部）；附 `problemCount` 与 `status`（`upcoming` / `ongoing` / `ended`，按 UTC 时间比较） | 公开（可选登录） |
| GET | `/api/contests/:id` | 比赛详情：含赛题列表 `problems`（id / 标题 / 时空限制 / 通信题标记 / 序号）；隐藏比赛对非管理员返回 404 | 公开（可选登录） |
| GET | `/api/contests/:id/scoreboard` | 比赛实时榜单（ACM/ICPC 规则，见下）；返回 `{contest, problems, rows, submissions}`，`contest` 含 `freezeTime`（封榜时间，可空），`submissions` 为按时间升序的比赛内已完成提交，供赛后滚榜重放 | 公开（可选登录） |
| POST | `/api/contests` | 创建比赛：`{title, description, startTime, endTime, freezeTime?, isPublic, problemIds}`；时间为 UTC `YYYY-MM-DD HH:MM[:SS]`；`freezeTime` 可空（null=不封榜），校验结束晚于开始、封榜时间在比赛区间内、赛题 id 全部存在 | 管理员 |
| PATCH | `/api/contests/:id` | 编辑比赛（部分字段；`problemIds` 提供时整体替换赛题；`freezeTime` 可更新或置空） | 管理员 |
| DELETE | `/api/contests/:id` | 删除比赛（赛题关联级联删除，不影响题目本身与已有提交） | 管理员 |
| GET | `/api/contests/:id/announcements` | 比赛通知列表（新 → 旧）：`[{id, title, content, author, createdAt}]`；隐藏比赛对非管理员返回 404 | 公开（可选登录） |
| POST | `/api/contests/:id/announcements` | 发布比赛通知：`{title, content}`；标题非空 ≤100、内容 ≤5000，首尾空格去除 | 管理员 |
| PATCH | `/api/contests/:id/announcements/:aid` | 编辑比赛通知（部分更新，至少提供一个字段） | 管理员 |
| DELETE | `/api/contests/:id/announcements/:aid` | 删除比赛通知 | 管理员 |

比赛通知口径：

- 读公开（游客 / 会员 / 管理员），写（发布 / 编辑 / 删除）仅管理员；隐藏比赛的通知与比赛详情同口径，对非管理员一律 404；
- 通知增删改经 WebSocket 广播 `{type:'contest-announcement', contestId}`，比赛页收到后刷新通知列表。

比赛榜单口径（ACM/ICPC）：

- 仅统计比赛内（`contest_id` 匹配）且状态 done 的提交，按提交时间（`created_at`）落在比赛区间内；
- 排名：AC 数降序 → 罚时升序 → 最近 AC 时间升序（早者靠前）；
- 罚时 = 各 AC 题首次 AC 用时分钟（向上取整，最小 1）+ 首次 AC 前错误提交数 × 20；CE 不计罚时但计尝试；AC 后提交不再计分；
- 封榜滚榜：比赛可配 `freezeTime`（可空，null = 不封榜，视为开赛即封榜）；封榜后的提交在实时榜上冻结，赛后滚榜从封榜时刻的榜单开始，按「当前排名从低到高」逐条揭晓，每揭晓一条重算一次排名；封榜榜上每队显示 `+N` 冻结数（N = 该队未揭晓的封榜后提交数）；
- 未开始 / 进行中 / 已结束比赛均可见榜单；赛后前端基于 `submissions` 序列做封榜滚榜：从封榜时刻的榜单开始，拖动进度条或逐条揭晓，全部揭晓后 = 终榜。

### users

| 方法 | 路径 | 说明 | 调用方 |
| --- | --- | --- | --- |
| GET | `/api/users/:username` | 用户公开主页：注册时间 + 做题统计（`stats`：提交总数 / AC 提交数 / 已解决题数 / 尝试未解决题数）+ 已解决题目列表（AC 去重）+ 尝试未解决题目列表（附最近判定）+ 最近 365 天提交热力图（`heatmap`，UTC 日期） | 公开（游客可见） |

### admin

| 方法 | 路径 | 说明 | 调用方 |
| --- | --- | --- | --- |
| GET | `/api/admin/users` | 用户列表（查看 / 管理角色） | 管理员 |
| PATCH | `/api/admin/users/:id/role` | 调整用户角色（不能修改自己的角色） | 管理员 |

### judge-api

| 方法 | 路径 | 说明 | 调用方 |
| --- | --- | --- | --- |
| GET | `/api/judge/tasks` | 任务拉取：按提交先后（FIFO）返回最早待评测任务（含源码与测试数据），拉取即置「评测中」，不重复发放；`?language=c,python,java` 按语言过滤（多语言后端评测机用它只拉非浏览器语言） | 评测机 |
| POST | `/api/judge/results` | 结果回传：`{submissionId, verdict, details, timeMs, memoryKb}`，评测中 → 完成并持久化 | 评测机 |

### 自助评测通道（纯前端评测机）

- 供提交者浏览器内的 Web Worker 评测机使用，JWT 鉴权，**仅限本人提交**（他人 403）；
- `POST /api/judge/self/claim`：`{submissionId}`。pending → 评测中，返回 `{submissionId, problemId, language, sourceCode, isCommunication, protocol, timeLimitMs, memoryLimitMb, testcases}`（通信题额外带 `isCommunication` 与解析后的 `protocol`）；**仅认领 cpp**（浏览器内实时编译），非 cpp 返回 400（由后端评测机处理）；评测中断（judging 且属本人）可重复认领恢复；已评测完成返回 400；
- `POST /api/judge/self/results`：`{submissionId, verdict, details, timeMs, memoryKb}`。评测中 → 完成，幂等（重复回传返回原判定）；`details` 为逐组明细数组 `[{ordinal, ok, input, expectedOutput, actualOutput}]`，**CE 时为编译错误文本字符串**（提交详情页按日志行渲染）；
- 该通道不接触 `x-judge-key`；结果回传后与其他通道一致，对所有人可见。

浏览器内评测流程（`public/js/judge.js` + `public/js/judge-worker.js`）：

1. 提交详情页 / 提交记录页自动认领本人待评测提交（串行队列，同一时刻一个提交）；
2. 主线程启动 module 型 Web Worker：worker 先用 WASM 工具链（emception，静态托管于 `/vendor/emception/*`）`em++` 把源码编译为 SINGLE_FILE 的 `main.js`；随后在 worker 的真实浏览器 V8 里直接执行编译产物（`new Function` 注入 `Module`，`stdin`/`stdout`/`stderr` 逐字节采集，与官方 demo 的浏览器内 eval 同路径——绕开 emception 的 quicknode，其为 WASM 版 node，无法实例化编译出的 wasm 模块），逐组注入输入运行并比对；
3. 超时由主线程 watchdog 强杀 worker 判 TLE；worker 异常 / 页面关闭时不回传结果，提交保持「评测中」，下次进入页面自动恢复；
4. 首次评测需下载解压工具链（约几十 MB，IndexedDB 缓存），此后明显加快；
5. 提供合成 `bits/stdc++.h` 万能头（emscripten 使用 libc++，不提供 libstdc++ 万能头；评测机按 sysroot 实际存在的头文件合成注入，编译参数 `-I/working` 优先命中）。语言口径为 **C++17**（`-std=c++17`）；C++20 专属头与线程同步类头不收录，用到相应特性的提交按 CE 处理。

### 多语言与后端评测机

- 支持语言：`cpp`（C++17，浏览器内实时编译）、`c`（C11，gcc）、`python`（Python 3）、`java`（Java，约定类名 `Main`）；
- 浏览器内实时编译（RUN/TEST 即时预览）**仅限 cpp**；c / python / java 提交后由后端评测机处理；
- 后端评测机：`npm run daemon`（`scripts/judge-daemon.js`）独立进程，轮询 `GET /api/judge/tasks?language=c,python,java` 拉取非浏览器语言任务，用系统编译器（gcc / python3 / javac）编译运行、逐组比对，回传 `POST /api/judge/results`；
- 后端评测机判定口径：编译失败 → CE；进程超时强杀 → TLE；非零退出 → RE（stderr 含 `out of memory` / `MemoryError` / `OutOfMemoryError` 等判 MLE）；输出比对 → AC / WA；`timeMs` 为各组耗时之和，`memoryKb` 后端语言不精确测量（回传 `null`）；
- 安全边界：本地演示用途，非生产级沙箱——仅进程超时强杀、输出 1MB 截断与独立临时目录；请勿对不可信网络开放评测机端口。

### docs

| 方法 | 路径 | 说明 | 调用方 |
| --- | --- | --- | --- |
| GET | `/api/docs` | 接口说明文档（程序化生成的 HTML） | 公开 |

## WebSocket 实时推送

- 路径：`/ws?token=<JWT>`
- 事件：`{type:'submission', submissionId, userId, status, verdict?}`，提交创建（pending）与完成（done + verdict）时推送；
- 比赛内提交评测完成时额外广播 `{type:'contest-scoreboard', contestId, submissionId}` 给所有在线登录用户，比赛详情页据此刷新榜单；
- 比赛通知增删改时广播 `{type:'contest-announcement', contestId}` 给所有在线登录用户，比赛详情页据此刷新通知列表；
- 受众：提交事件推送给提交者本人 + 所有在线管理员；比赛榜单 / 通知事件广播给所有在线登录用户。

## 请求 / 响应示例

提交代码：

```json
POST /api/submissions
Authorization: Bearer <会员JWT>
{ "problemId": 1, "language": "cpp", "sourceCode": "#include <iostream>\nint main(){int a,b;std::cin>>a>>b;std::cout<<a+b;}", "isPublic": 1 }
→ 201 { "id": 1, "status": "pending" }
```

按题查看提交记录：

```json
GET /api/submissions?problemId=1
→ [ { "id": 2, "problemId": 1, "problemTitle": "A+B Problem", "username": "demo", "status": "done", "verdict": "AC", ... }, ... ]
```

查看他人未公开提交（评测结果可见、源码隐藏）：

```json
GET /api/submissions/2
→ { "id": 2, "status": "done", "verdict": "WA", "isPublic": 0, "sourceCode": null, ... }
```

任务拉取：

```json
GET /api/judge/tasks
x-judge-key: <key>
→ { "task": { "id": 1, "problemId": 1, "language": "cpp", "sourceCode": "...", "testcases": [{ "ordinal": 1, "input": "1 2\n", "expectedOutput": "3\n" }, ...] } }
```

结果回传：

```json
POST /api/judge/results
x-judge-key: <key>
{ "submissionId": 1, "verdict": "AC", "details": [{ "ordinal": 1, "ok": true, "input": "1 2\n", "expectedOutput": "3\n", "actualOutput": "3\n" }], "timeMs": 12, "memoryKb": 1024 }
→ { "ok": true, "submissionId": 1, "status": "done", "verdict": "AC" }
```

自助认领（浏览器内评测机，JWT）：

```json
POST /api/judge/self/claim
Authorization: Bearer <JWT>
{ "submissionId": 5 }
→ { "submissionId": 5, "problemId": 1, "language": "cpp", "sourceCode": "...",
    "timeLimitMs": 1000, "memoryLimitMb": 64,
    "testcases": [{ "ordinal": 1, "input": "1 2\n", "expectedOutput": "3\n" }, ...] }
```

自助回传：

```json
POST /api/judge/self/results
Authorization: Bearer <JWT>
{ "submissionId": 5, "verdict": "WA", "details": [...], "timeMs": 8, "memoryKb": 512 }
→ { "ok": true, "submissionId": 5, "status": "done", "verdict": "WA" }
```

编译错误（CE）回传（details 为编译错误文本）：

```json
POST /api/judge/self/results
Authorization: Bearer <JWT>
{ "submissionId": 6, "verdict": "CE", "details": "main.cpp:3:1: error: expected ';' ...", "timeMs": 5231 }
→ { "ok": true, "submissionId": 6, "status": "done", "verdict": "CE" }
```

创建比赛：

```json
POST /api/contests
Authorization: Bearer <管理员JWT>
{ "title": "周赛 #1", "description": "入门练习", "startTime": "2026-08-24 12:00:00", "endTime": "2026-08-24 14:00:00", "isPublic": 1, "problemIds": [1, 2] }
→ 201 { "id": 1, "title": "周赛 #1", "status": "upcoming", "problems": [ { "id": 1, "title": "A+B Problem", "ordinal": 1, ... }, ... ] }
```

比赛榜单（cells 按赛题顺序，`-N` = N 次错误尝试未过，`-` = 仅 CE 尝试无罚时）：

```json
GET /api/contests/1/scoreboard
→ { "contest": { "id": 1, "startTime": "...", "endTime": "..." },
    "problems": [ { "ordinal": 1, "problemId": 1, "title": "A+B Problem" } ],
    "rows": [ { "rank": 1, "username": "demo", "solved": 1, "penalty": 83,
                "cells": [ { "problemId": 1, "status": "ac", "attempts": 2, "wrong": 1, "acTime": 63 } ] } ],
    "submissions": [ { "id": 5, "username": "demo", "verdict": "WA", "createdAt": "..." }, ... ] }
```
