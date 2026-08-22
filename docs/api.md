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
- MLE：编译期把 WASM 内存上限设为题限（`INITIAL_MEMORY = max(题限, 20MB)`，不 `ALLOW_MEMORY_GROWTH`），运行中分配超限触发 OOM abort，按 stderr 特征串（`Aborted(OOM)` / `bad_alloc` 等）识别；通信题另按堆大小 ≥ 题限×0.9 兜底；
- `timeMs` 为各组 wall-clock 耗时之和（近似值），`memoryKb` 为 WASM 堆大小近似（该口径下约等于题限，非实际峰值）；
- 输出比对：逐行忽略行尾空白、忽略末尾空行，首错即停（WA/TLE/MLE/RE 不再评测后续组，剩余组明细 `ok:false`、`actualOutput:""`）；
- 精确计时与内存测量不在本项目范围内。

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
| POST | `/api/submissions` | 提交代码，生成评测任务（状态 pending；通信题同样可提交，评测走两进程函数式）；`isPublic` 设置代码公开性（0/1，默认 1 公开） | 会员 / 管理员 |
| GET | `/api/submissions` | 提交列表（最近 200 条，按提交时间倒序，含题目标题与提交者）；支持 `?problemId=` 只看某题 | 公开（游客可见） |
| GET | `/api/submissions/:id` | 提交详情：评测结果人人可见；源代码仅本人 / 管理员 / 公开提交可见，未公开时 `sourceCode` 返回 `null` | 公开（游客可见） |

### admin

| 方法 | 路径 | 说明 | 调用方 |
| --- | --- | --- | --- |
| GET | `/api/admin/users` | 用户列表（查看 / 管理角色） | 管理员 |
| PATCH | `/api/admin/users/:id/role` | 调整用户角色（不能修改自己的角色） | 管理员 |

### judge-api

| 方法 | 路径 | 说明 | 调用方 |
| --- | --- | --- | --- |
| GET | `/api/judge/tasks` | 任务拉取：按提交先后（FIFO）返回最早待评测任务（含源码与测试数据），拉取即置「评测中」，不重复发放 | 评测机 |
| POST | `/api/judge/results` | 结果回传：`{submissionId, verdict, details, timeMs, memoryKb}`，评测中 → 完成并持久化 | 评测机 |

### 自助评测通道（纯前端评测机）

- 供提交者浏览器内的 Web Worker 评测机使用，JWT 鉴权，**仅限本人提交**（他人 403）；
- `POST /api/judge/self/claim`：`{submissionId}`。pending → 评测中，返回 `{submissionId, problemId, language, sourceCode, isCommunication, protocol, timeLimitMs, memoryLimitMb, testcases}`（通信题额外带 `isCommunication` 与解析后的 `protocol`）；评测中断（judging 且属本人）可重复认领恢复；已评测完成返回 400；
- `POST /api/judge/self/results`：`{submissionId, verdict, details, timeMs, memoryKb}`。评测中 → 完成，幂等（重复回传返回原判定）；`details` 为逐组明细数组 `[{ordinal, ok, input, expectedOutput, actualOutput}]`，**CE 时为编译错误文本字符串**（提交详情页按日志行渲染）；
- 该通道不接触 `x-judge-key`；结果回传后与其他通道一致，对所有人可见。

浏览器内评测流程（`public/js/judge.js` + `public/js/judge-worker.js`）：

1. 提交详情页 / 提交记录页自动认领本人待评测提交（串行队列，同一时刻一个提交）；
2. 主线程启动 module 型 Web Worker：worker 先用 WASM 工具链（emception，静态托管于 `/vendor/emception/*`）`em++` 把源码编译为 SINGLE_FILE 的 `main.js`；随后在 worker 的真实浏览器 V8 里直接执行编译产物（`new Function` 注入 `Module`，`stdin`/`stdout`/`stderr` 逐字节采集，与官方 demo 的浏览器内 eval 同路径——绕开 emception 的 quicknode，其为 WASM 版 node，无法实例化编译出的 wasm 模块），逐组注入输入运行并比对；
3. 超时由主线程 watchdog 强杀 worker 判 TLE；worker 异常 / 页面关闭时不回传结果，提交保持「评测中」，下次进入页面自动恢复；
4. 首次评测需下载解压工具链（约几十 MB，IndexedDB 缓存），此后明显加快；
5. 提供合成 `bits/stdc++.h` 万能头（emscripten 使用 libc++，不提供 libstdc++ 万能头；评测机按 sysroot 实际存在的头文件合成注入，编译参数 `-I/working` 优先命中）。语言口径为 **C++17**（`-std=c++17`）；C++20 专属头与线程同步类头不收录，用到相应特性的提交按 CE 处理。

### docs

| 方法 | 路径 | 说明 | 调用方 |
| --- | --- | --- | --- |
| GET | `/api/docs` | 接口说明文档（程序化生成的 HTML） | 公开 |

## WebSocket 实时推送

- 路径：`/ws?token=<JWT>`
- 事件：`{type:'submission', submissionId, userId, status, verdict?}`，提交创建（pending）与完成（done + verdict）时推送；
- 受众：提交者本人 + 所有在线管理员。

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
