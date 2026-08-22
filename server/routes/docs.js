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
  { method: 'POST', path: '/api/submissions', desc: '提交代码（生成评测任务，状态 pending）；isPublic 设置代码公开性（0/1，默认公开）', caller: '会员/管理员', auth: 'Bearer JWT', body: '{problemId, language:"cpp", sourceCode, isPublic}' },
  { method: 'GET', path: '/api/submissions', desc: '提交列表（全部提交按时间倒序，最近 200 条）；?problemId= 只看某题', caller: '公开（游客可见）', auth: '可选 Bearer JWT' },
  { method: 'GET', path: '/api/submissions/:id', desc: '提交详情（评测结果人人可见；源码仅本人/管理员/公开提交可见）', caller: '公开（游客可见）', auth: '可选 Bearer JWT' },
  { method: 'GET', path: '/api/admin/users', desc: '用户列表（查看/管理角色）', caller: '管理员', auth: 'Bearer JWT' },
  { method: 'PATCH', path: '/api/admin/users/:id/role', desc: '调整用户角色', caller: '管理员', auth: 'Bearer JWT', body: '{role:"member"|"admin"}' },
  { method: 'GET', path: '/api/judge/tasks', desc: '任务拉取：FIFO 返回最早待评测任务（题目、语言、源码、测试数据），拉取即置评测中', caller: '评测机', auth: 'x-judge-key 请求头' },
  { method: 'POST', path: '/api/judge/results', desc: '结果回传：评测中 → 完成，写入判定与明细', caller: '评测机', auth: 'x-judge-key 请求头', body: '{submissionId, verdict, details, timeMs, memoryKb}' },
  { method: 'POST', path: '/api/judge/self/claim', desc: '自助认领本人待评测提交（pending → 评测中），返回源码 + 限制 + 测试数据；评测中断（judging）可重复认领恢复；通信题返回 isCommunication + protocol', caller: '会员/管理员（仅本人）', auth: 'Bearer JWT', body: '{submissionId}' },
  { method: 'POST', path: '/api/judge/self/results', desc: '自助回传本人提交的评测结果（评测中 → 完成，幂等）；CE 时 details 为编译错误文本，其余判定 details 为逐组明细数组', caller: '会员/管理员（仅本人）', auth: 'Bearer JWT', body: '{submissionId, verdict, details, timeMs, memoryKb}' },
  { method: 'GET', path: '/api/docs', desc: '本接口说明文档', caller: '公开' },
];

const NOTES = [
  '鉴权：除标注 x-judge-key 的接口外，受保护接口使用 Authorization: Bearer &lt;JWT&gt;；未登录返回 401，角色不足返回 403。',
  '评测状态机：pending（等待中）→ judging（评测中）→ done（完成，附 verdict：AC / WA / TLE / MLE / RE / CE）。',
  '实时推送：WebSocket 路径 /ws?token=&lt;JWT&gt;，提交状态变化时推送给提交者本人与所有在线管理员。',
  '评测判定口径：TLE 用 wall-clock（普通题 题限 + 3s WASM 启动裕量，通信题 + 6s，超时由页面主线程强杀评测 worker）近似；MLE 用 WASM 内存上限（编译期 INITIAL_MEMORY 设为题限、下限 20MB，不 ALLOW_MEMORY_GROWTH，运行时超限 OOM abort 识别）近似；timeMs 为各组耗时之和（近似值），memoryKb 为 WASM 堆大小近似（该口径下约等于题限，非实际峰值）；逐组比对忽略行尾空白与末尾空行，首错即停。',
  '双通道评测：外部评测机走 x-judge-key 通道（tasks/results）；纯前端评测（提交者浏览器 Web Worker 内编译运行）走自助通道（self/claim + self/results），仅能评测本人提交，结果回传后即对所有人可见。',
  '浏览器内评测流程：提交详情页 / 提交记录页自动认领本人待评测提交，在浏览器 Web Worker 中先用 WASM 工具链（emception）编译，再在 worker 的真实浏览器 V8 中执行编译产物（new Function 注入 Module，绕开 quicknode——其为 WASM 版 node，无法实例化编译出的 wasm 模块）；提供合成 bits/stdc++.h 万能头（libc++ 不提供该头，按 sysroot 实际头文件合成注入），语言口径 C++17（C++20 专属特性不支持）；首次加载需下载解压工具链（约几十 MB，走 IndexedDB 缓存），之后明显加快；评测中断（关页 / 超时强杀 / 异常）不回传结果，提交保持评测中，下次进入页面自动恢复。',
  '通信题（is_communication=1）：两进程函数式评测。提交的程序实现协议两个函数（默认 Alice/Bob，签名 fn1(std::string)→int、fn2(std::string,int)→int）；每组数据「两次独立实例化 JudgeModule」分别运行，函数一返回值 X（限 [0, xMax]）作为函数二输入，最终输出与标准输出比对。编译时注入 C 链接 wrapper 把 ccall 的 char* 转 std::string；中间值越界判 RE。测试数据约定 input 为两行 "S\\nT\\n"，expectedOutput 为期望最终输出。',
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
