// docs 模块：接口说明文档（与路由同源维护，程序化生成 HTML，保证文档与实现一致）
const express = require('express');

const router = express.Router();

// 接口清单（与 server/routes/ 各文件保持一致）
const APIS = [
  { method: 'POST', path: '/api/auth/register', desc: '题库注册（注册后即为会员）', caller: '公开（游客）', body: '{username, password}' },
  { method: 'POST', path: '/api/auth/login', desc: '登录（会员 / 管理员同一入口），返回 JWT', caller: '公开', body: '{username, password}' },
  { method: 'POST', path: '/api/problems', desc: '发布题目（题面、时空限制、题解隐藏区、≥3 组测试数据）', caller: '管理员', auth: 'Bearer JWT' },
  { method: 'GET', path: '/api/problems', desc: '题库题目列表（游客/会员只见已上架，管理员见全部）', caller: '公开（游客/会员）', auth: '可选 Bearer JWT' },
  { method: 'GET', path: '/api/problems/:id', desc: '题目详情（会员含测试数据；题解按 solutionVisible；管理员含全部）', caller: '公开（游客/会员）', auth: '可选 Bearer JWT' },
  { method: 'PATCH', path: '/api/problems/:id', desc: '编辑 / 上下架题目（测试数据整体替换）', caller: '管理员', auth: 'Bearer JWT' },
  { method: 'GET', path: '/api/contests', desc: '比赛列表（游客/会员见公开，管理员见全部；附 problemCount 与 status：upcoming/ongoing/ended）', caller: '公开（游客/会员）', auth: '可选 Bearer JWT' },
  { method: 'GET', path: '/api/contests/:id', desc: '比赛详情（含赛题列表 problems）', caller: '公开（游客/会员）', auth: '可选 Bearer JWT' },
  { method: 'GET', path: '/api/contests/:id/scoreboard', desc: '比赛实时榜单（ACM 规则：AC 数降序、罚时升序；返回 problems/rows/submissions，contest 含 freezeTime，submissions 供赛后封榜滚榜重放）', caller: '公开（游客/会员）', auth: '可选 Bearer JWT' },
  { method: 'POST', path: '/api/contests', desc: '创建比赛（标题、简介、开始/结束时间、封榜时间、可见性、赛题 id 列表）', caller: '管理员', auth: 'Bearer JWT', body: '{title, description, startTime, endTime, freezeTime?, isPublic, problemIds}' },
  { method: 'PATCH', path: '/api/contests/:id', desc: '编辑比赛（赛题整体替换）', caller: '管理员', auth: 'Bearer JWT' },
  { method: 'DELETE', path: '/api/contests/:id', desc: '删除比赛（赛题关联级联删除，不影响题目本身）', caller: '管理员', auth: 'Bearer JWT' },
  { method: 'GET', path: '/api/contests/:id/announcements', desc: '比赛通知列表（新→旧，含 title/content/author/createdAt）', caller: '公开（游客/会员）', auth: '可选 Bearer JWT' },
  { method: 'POST', path: '/api/contests/:id/announcements', desc: '发布比赛通知（标题 ≤100、内容 ≤5000，首尾空格去除）；经 WebSocket 广播 contest-announcement', caller: '管理员', auth: 'Bearer JWT', body: '{title, content}' },
  { method: 'PATCH', path: '/api/contests/:id/announcements/:aid', desc: '编辑比赛通知（部分更新）；经 WebSocket 广播 contest-announcement', caller: '管理员', auth: 'Bearer JWT', body: '{title?, content?}' },
  { method: 'DELETE', path: '/api/contests/:id/announcements/:aid', desc: '删除比赛通知；经 WebSocket 广播 contest-announcement', caller: '管理员', auth: 'Bearer JWT' },
  { method: 'POST', path: '/api/submissions', desc: '提交代码（生成评测任务，状态 pending）；language 支持 c / cpp / python / java（cpp 浏览器内实时编译，其余走后端评测机；通信题强制 cpp）；isPublic 设置代码公开性（0/1，默认公开）；contestId 表示比赛内提交（校验比赛存在、题目归属、进行中）', caller: '会员/管理员', auth: 'Bearer JWT', body: '{problemId, language:"cpp", sourceCode, isPublic, contestId}' },
  { method: 'GET', path: '/api/submissions', desc: '提交列表（全部提交按时间倒序，最近 200 条）；?problemId= 只看某题；?contestId= 只看某比赛', caller: '公开（游客可见）', auth: '可选 Bearer JWT' },
  { method: 'GET', path: '/api/submissions/:id', desc: '提交详情（评测结果人人可见；源码仅本人/管理员/公开提交可见）', caller: '公开（游客可见）', auth: '可选 Bearer JWT' },
  { method: 'GET', path: '/api/admin/users', desc: '用户列表（查看/管理角色）', caller: '管理员', auth: 'Bearer JWT' },
  { method: 'PATCH', path: '/api/admin/users/:id/role', desc: '调整用户角色', caller: '管理员', auth: 'Bearer JWT', body: '{role:"member"|"admin"}' },
  { method: 'GET', path: '/api/judge/tasks', desc: '任务拉取：FIFO 返回最早待评测任务（题目、语言、源码、测试数据），拉取即置评测中；?language=c,python,java 按语言过滤（多语言后端评测机用它只拉非浏览器语言）', caller: '评测机', auth: 'x-judge-key 请求头' },
  { method: 'POST', path: '/api/judge/results', desc: '结果回传：评测中 → 完成，写入判定与明细', caller: '评测机', auth: 'x-judge-key 请求头', body: '{submissionId, verdict, details, timeMs, memoryKb}' },
  { method: 'POST', path: '/api/judge/self/claim', desc: '自助认领本人待评测提交（pending → 评测中），返回源码 + 限制 + 测试数据；评测中断（judging）可重复认领恢复；仅认领 cpp（浏览器内实时编译），非 cpp 返回 400；通信题返回 isCommunication + protocol', caller: '会员/管理员（仅本人）', auth: 'Bearer JWT', body: '{submissionId}' },
  { method: 'POST', path: '/api/judge/self/results', desc: '自助回传本人提交的评测结果（评测中 → 完成，幂等）；CE 时 details 为编译错误文本，其余判定 details 为逐组明细数组', caller: '会员/管理员（仅本人）', auth: 'Bearer JWT', body: '{submissionId, verdict, details, timeMs, memoryKb}' },
  { method: 'GET', path: '/api/docs', desc: '本接口说明文档', caller: '公开' },
];

const NOTES = [
  '鉴权：除标注 x-judge-key 的接口外，受保护接口使用 Authorization: Bearer &lt;JWT&gt;；未登录返回 401，角色不足返回 403。',
  '评测状态机：pending（等待中）→ judging（评测中）→ done（完成，附 verdict：AC / WA / TLE / MLE / RE / CE）。',
  '实时推送：WebSocket 路径 /ws?token=&lt;JWT&gt;，提交状态变化时推送给提交者本人与所有在线管理员；比赛内提交评测完成时额外广播 {type:"contest-scoreboard", contestId} 给所有在线用户，榜单页据此刷新；比赛通知增删改时广播 {type:"contest-announcement", contestId}，比赛页据此刷新通知列表。',
  '比赛榜单（ACM/ICPC 规则）：仅统计比赛内（contest_id 匹配）且状态 done 的提交；按 AC 数降序 → 罚时升序（罚时 = 各 AC 题首次 AC 用时分钟向上取整 + 首次 AC 前错误提交数 ×20，CE 不计错误次数）→ 最近 AC 时间升序排名；比赛可配封榜时间 freezeTime（可空，null=不封榜），封榜后提交冻结（榜单显示 +N 冻结数）；未开始/进行中/已结束比赛均可见榜单，赛后由前端基于 submissions 序列做封榜滚榜——从封榜时刻榜单开始、按「当前排名从低到高」逐条揭晓、拖动进度条或逐步重算排名，全部揭晓后=终榜。',
  '评测判定口径：TLE 用 wall-clock（普通题 题限 + 3s WASM 启动裕量，通信题 + 6s，超时由页面主线程强杀评测 worker）近似；MLE 用 WASM 内存上限（编译期 INITIAL_MEMORY 设为题限、下限 20MB，不 ALLOW_MEMORY_GROWTH，运行时超限 OOM abort 识别）近似；timeMs 为各组耗时之和（近似值），memoryKb 为 WASM 堆大小近似（该口径下约等于题限，非实际峰值）；逐组比对忽略行尾空白与末尾空行，首错即停。',
  '双通道评测：外部评测机走 x-judge-key 通道（tasks/results）；纯前端评测（提交者浏览器 Web Worker 内编译运行）走自助通道（self/claim + self/results），仅能评测本人提交，结果回传后即对所有人可见。',
  '多语言支持：C++（cpp）在浏览器内用 WASM 工具链实时编译运行（RUN/TEST 即时预览仅限 cpp）；C（gcc）、Python 3（python3）、Java（javac，约定类名 Main）由后端评测机评测（npm run daemon 启动，用系统编译器编译运行，进程超时强杀 + 输出截断，非生产级沙箱）。',
  '浏览器内评测流程：提交详情页 / 提交记录页自动认领本人待评测提交，在浏览器 Web Worker 中先用 WASM 工具链（emception）编译，再在 worker 的真实浏览器 V8 中执行编译产物（new Function 注入 Module，绕开 quicknode——其为 WASM 版 node，无法实例化编译出的 wasm 模块）；提供合成 bits/stdc++.h 万能头（libc++ 不提供该头，按 sysroot 实际头文件合成注入），语言口径 C++17（C++20 专属特性不支持）；首次加载需下载解压工具链（约几十 MB，走 IndexedDB 缓存），之后明显加快；评测中断（关页 / 超时强杀 / 异常）不回传结果，提交保持评测中，下次进入页面自动恢复。',
  '通信题（is_communication=1）：两进程函数式评测。提交的程序实现协议两个函数（不写 main，签名按 protocol 声明，见下）；每组数据「两次独立实例化 JudgeModule」分别运行，函数一返回值 X（int/long long 限 [0, xMax]、string 限 maxIntermediateBytes 长度，越界判 RE）作为函数二输入（位置由 fn2.xParam 指定，X 类型 = fn1 返回），最终输出与标准输出比对。two-phase 类型菜单：参数 string / int / long long / vector<int>，返回 string / int / long long；fn1 / fn2 可为函数名字符串（旧式，默认签名 fn1(string)→int、fn2(string,int)→int）或签名对象 {name, params, ret}（新式，fn2 另带 xParam）。可选 mutate（中间值变换）：noise-num——X（空格分隔数字串）每数字按 ratio 概率替换成 [min,max] 随机数（噪声信道）；delete-edges——X（空格分隔边集 u1 v1 u2 v2 ...）按 seed 随机删恰好 delete 条边，可选 meta（前 meta 个数为元数据、不参与删边）（删边信道）；两者 seed 固定、评测可复现。编译时按签名生成 C 链接 wrapper：int 走 ccall number，long long 走十进制字符串（strtoll / std::to_string，64 位全精度），string 走 char*，vector<int> 走 int* 缓冲；stations driver（P6838）为数组参数 + 数组返回（out 参数）+ 内置 grader。测试数据约定：two-phase 的 input 每行一个参数（依次 fn1 全部参数 → fn2 除 X 外参数），expectedOutput 为期望最终输出；stations 为官方样例评测器格式。',
];

function render() {
  const rows = APIS.map(
    (a) => `<tr>
      <td><b>${a.method}</b></td>
      <td><code>${a.path}</code></td>
      <td>${a.desc}</td>
      <td>${a.caller}</td>
      <td>${a.auth || '-'}</td>
      <td>${a.body ? `<code>${a.body}</code>` : '-'}</td>
    </tr>`
  ).join('');
  const notes = NOTES.map((n) => `<li>${n}</li>`).join('');
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>WebOJ 接口文档</title>
<style>
  body { font-family: system-ui, "Microsoft YaHei", sans-serif; max-width: 1100px; margin: 2em auto; padding: 0 1em; color: #1a1a1a; }
  h1 { border-bottom: 2px solid #2563eb; padding-bottom: .3em; }
  table { border-collapse: collapse; width: 100%; font-size: 14px; }
  th, td { border: 1px solid #ddd; padding: 6px 10px; text-align: left; vertical-align: top; }
  th { background: #f3f4f6; }
  code { background: #f3f4f6; padding: 1px 5px; border-radius: 3px; font-size: 13px; }
  ul { line-height: 1.9; }
</style>
</head>
<body>
<h1>WebOJ 接口文档</h1>
<p>共 ${APIS.length} 条接口。本文档由 server/routes/docs.js 程序化生成，与实现保持一致。</p>
<h2>接口清单</h2>
<table>
<thead><tr><th>方法</th><th>路径</th><th>说明</th><th>调用方</th><th>鉴权</th><th>请求体</th></tr></thead>
<tbody>${rows}</tbody>
</table>
<h2>说明</h2>
<ul>${notes}</ul>
</body>
</html>`;
}

router.get('/', (req, res) => {
  res.type('html').send(render());
});

module.exports = router;
