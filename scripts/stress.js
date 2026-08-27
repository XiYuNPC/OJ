// 高压测试脚本（后端接口层）：node scripts/stress.js（npm run stress）
// 覆盖并发正确性 + 吞吐/延迟 + 稳定性，使用内存 SQLite，不污染演示数据。
// 说明：浏览器内评测机（emception 编译 + worker 执行）需浏览器环境，不在此脚本范围；
//       本脚本聚焦后端「提交 → 任务拉取 → 结果回传」主路径的并发正确性与性能。
process.env.DB_PATH = ':memory:';

const http = require('http');
const { performance } = require('perf_hooks');
const db = require('../server/db');
const app = require('../server/app');
const config = require('../server/config');
const ws = require('../server/ws');
require('./seed'); // 内存库注入演示数据

// 题目 id 按标记查询（不依赖 seed 插入顺序）
const problemId = (isComm) => db.prepare('SELECT id FROM problems WHERE is_communication = ? ORDER BY id LIMIT 1').get(isComm ? 1 : 0).id;
const abProblemId = problemId(0);    // A+B Problem
const commProblemId = problemId(1);  // 通信题 P12509

const server = http.createServer(app);
ws.init(server);

// ===== 压力参数（可用环境变量覆盖）=====
const REG_CONCURRENCY = Number(process.env.REG_CONCURRENCY || 50);   // 并发注册同名用户
const SUB_CONCURRENCY = Number(process.env.SUB_CONCURRENCY || 300);  // 并发提交
const PULL_CONCURRENCY = Number(process.env.PULL_CONCURRENCY || 300); // 并发任务拉取（须 ≥ SUB_CONCURRENCY，超出部分期望 task:null）
const RESULT_CONCURRENCY = Number(process.env.RESULT_CONCURRENCY || 50); // 并发回传同一提交
const GET_QPS_LOOPS = Number(process.env.GET_QPS_LOOPS || 1000);     // 顺序吞吐采样次数
const LOGIN_CONCURRENCY = Number(process.env.LOGIN_CONCURRENCY || 50); // 并发登录（验证 scrypt 异步化后不再阻塞事件循环）

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); }
  else { fail += 1; console.error(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
}

// 共享连接池：限制并发 socket 数（keep-alive + maxSockets），排队复用连接。
// 目的：避免「瞬时 N 个并发新 TCP 连接」在本地回环被内核拒绝（ECONNREFUSED），
//       从而聚焦测试应用层（Express 路由 / SQLite / 任务队列）在高吞吐下的正确性与稳定性。
const agent = new http.Agent({ keepAlive: true, maxSockets: 64 });

function httpReq(method, path, { token, key, body } = {}) {
  return new Promise((resolve) => {
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    if (key) headers['x-judge-key'] = key;
    const payload = body === undefined ? null : JSON.stringify(body);
    if (payload !== null) headers['Content-Type'] = 'application/json';
    const t0 = performance.now();
    const req = http.request(
      { host: '127.0.0.1', port: server.address().port, path, method, headers, agent },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(data); } catch (e) {}
          resolve({ status: res.statusCode, json, ms: performance.now() - t0 });
        });
      }
    );
    req.on('error', (e) => resolve({ status: 0, json: null, ms: performance.now() - t0, error: e.message }));
    req.setTimeout(15000, () => req.destroy(new Error('客户端超时 15s'))); // 防止后端挂起时压测无限等待
    if (payload !== null) req.write(payload);
    req.end();
  });
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil(p * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}
function latencyReport(label, times) {
  const s = [...times].sort((a, b) => a - b);
  const avg = times.reduce((a, b) => a + b, 0) / times.length;
  console.log(`  ${label}: avg=${avg.toFixed(1)}ms p50=${percentile(s, 0.5).toFixed(1)}ms p95=${percentile(s, 0.95).toFixed(1)}ms p99=${percentile(s, 0.99).toFixed(1)}ms max=${s[s.length - 1].toFixed(1)}ms`);
}

async function main() {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const key = config.judgeApiKey;

  // 准备：一个会员 + 一个管理员
  const member = 'stress_' + Date.now();
  await httpReq('POST', '/api/auth/register', { body: { username: member, password: 'pass123456' } });
  const login = await httpReq('POST', '/api/auth/login', { body: { username: member, password: 'pass123456' } });
  const token = login.json.token;
  const adminLogin = await httpReq('POST', '/api/auth/login', { body: { username: 'admin', password: 'admin123' } });
  const adminToken = adminLogin.json.token;

  console.log('\n===== 场景 1：并发注册同名用户（唯一约束）=====');
  {
    const uname = 'stress_dup_' + Date.now();
    const rs = await Promise.all(Array.from({ length: REG_CONCURRENCY }, () =>
      httpReq('POST', '/api/auth/register', { body: { username: uname, password: 'pass123456' } })
    ));
    const ok = rs.filter((r) => r.status === 201).length;
    const dup = rs.filter((r) => r.status === 409).length;
    const other = rs.filter((r) => r.status !== 201 && r.status !== 409).length;
    check(`并发 ${REG_CONCURRENCY} 注册同名：恰好 1 个成功`, ok === 1, `成功=${ok}`);
    check(`其余全部 409（无 500/崩溃）`, dup === REG_CONCURRENCY - 1 && other === 0, `409=${dup}, 其他=${other}`);
  }

  console.log('\n===== 场景 2：并发提交（吞吐 + 状态正确）=====');
  {
    const t0 = performance.now();
    const rs = await Promise.all(Array.from({ length: SUB_CONCURRENCY }, () =>
      httpReq('POST', '/api/submissions', { token, body: { problemId: abProblemId, language: 'cpp', sourceCode: 'int main(){int a,b;std::cin>>a>>b;std::cout<<a+b;}' } })
    ));
    const totalMs = performance.now() - t0;
    const ok = rs.filter((r) => r.status === 201 && r.json.status === 'pending').length;
    const bad = rs.filter((r) => r.status !== 201);
    if (bad.length) {
      const dist = {};
      for (const r of bad) { const k = r.error ? ('socket:' + r.error) : ('http:' + r.status); dist[k] = (dist[k] || 0) + 1; }
      console.log(`  失败分布：${JSON.stringify(dist)}`);
    }
    check(`并发 ${SUB_CONCURRENCY} 提交全部 201 且 pending`, ok === SUB_CONCURRENCY && bad.length === 0, `201=${ok}, 非201=${bad.length}`);
    console.log(`  总耗时 ${totalMs.toFixed(0)}ms，吞吐 ${(SUB_CONCURRENCY / (totalMs / 1000)).toFixed(0)} 提交/秒`);
  }

  console.log('\n===== 场景 3：并发任务拉取（不重复、不遗漏，FIFO 核心）=====');
  {
    // 场景 2 已产生 SUB_CONCURRENCY 个 pending；并发拉取，验证每个任务恰好发放一次
    const rs = await Promise.all(Array.from({ length: PULL_CONCURRENCY }, () =>
      httpReq('GET', '/api/judge/tasks', { key })
    ));
    const ids = rs.map((r) => r.json && r.json.task && r.json.task.id).filter((x) => x != null);
    const uniq = new Set(ids).size;
    const nulls = rs.filter((r) => r.json && r.json.task === null).length;
    const errors = rs.filter((r) => r.status !== 200).length;
    check(`并发 ${PULL_CONCURRENCY} 拉取：每个任务只发一次（无重复）`, uniq === ids.length && uniq === SUB_CONCURRENCY, `拿到=${ids.length}, 去重=${uniq}`);
    check(`超出队列的部分返回 task:null（不重发）`, nulls === PULL_CONCURRENCY - SUB_CONCURRENCY, `null=${nulls}`);
    check(`无 401/500`, errors === 0, `错误=${errors}`);
  }

  console.log('\n===== 场景 4：并发结果回传同一提交（幂等）=====');
  {
    // 取场景 3 中已置 judging 的某个提交，并发回传不同 verdict
    const claimed = db.prepare(`SELECT id FROM submissions WHERE status='judging' ORDER BY id LIMIT 1`).get();
    check('存在已拉取（judging）的提交', !!claimed);
    if (claimed) {
      const verdicts = ['AC', 'WA', 'TLE', 'MLE', 'RE', 'CE'];
      const rs = await Promise.all(Array.from({ length: RESULT_CONCURRENCY }, (_, i) =>
        httpReq('POST', '/api/judge/results', { key, body: { submissionId: claimed.id, verdict: verdicts[i % 6], timeMs: 10, memoryKb: 1024 } })
      ));
      const ok = rs.filter((r) => r.status === 200).length;
      const row = db.prepare('SELECT status, verdict FROM submissions WHERE id = ?').get(claimed.id);
      check(`并发 ${RESULT_CONCURRENCY} 回传全部 200（首个写入，其余幂等）`, ok === RESULT_CONCURRENCY, `200=${ok}`);
      check('最终状态 done 且有唯一 verdict', row.status === 'done' && ['AC', 'WA', 'TLE', 'MLE', 'RE', 'CE'].includes(row.verdict), `verdict=${row.verdict}`);
    }
  }

  console.log('\n===== 场景 5：吞吐 / 延迟基准（顺序 + 并发登录对照）=====');
  {
    // GET 题库列表（游客可见，无鉴权开销）
    let times = [];
    for (let i = 0; i < GET_QPS_LOOPS; i++) {
      const r = await httpReq('GET', '/api/problems');
      if (r.status !== 200) { check('题库列表 GET 全 200', false, `status=${r.status}`); break; }
      times.push(r.ms);
    }
    if (times.length === GET_QPS_LOOPS) check(`题库列表 GET ×${GET_QPS_LOOPS} 全 200`, true);
    latencyReport('GET /api/problems 延迟', times);

    // 登录（含 scrypt 哈希，CPU 密集，测其在高频下的延迟）
    times = [];
    for (let i = 0; i < 100; i++) {
      const r = await httpReq('POST', '/api/auth/login', { body: { username: member, password: 'pass123456' } });
      if (r.status !== 200) { check('登录 POST 全 200', false); break; }
      times.push(r.ms);
    }
    if (times.length === 100) check('登录 POST ×100 全 200', true);
    latencyReport('POST /api/auth/login 延迟（含 scrypt）', times);

    // 并发登录：scrypt 走异步（libuv 线程池），不阻塞事件循环，并发请求并行处理 → 总耗时远低于串行之和
    {
      const seqAvg = times.reduce((a, b) => a + b, 0) / times.length; // 上一块顺序登录的均值（单次 scrypt 开销）
      const t0 = performance.now();
      const rs = await Promise.all(Array.from({ length: LOGIN_CONCURRENCY }, () =>
        httpReq('POST', '/api/auth/login', { body: { username: member, password: 'pass123456' } })
      ));
      const totalMs = performance.now() - t0;
      const ok = rs.filter((r) => r.status === 200).length;
      check(`并发 ${LOGIN_CONCURRENCY} 登录全部 200`, ok === LOGIN_CONCURRENCY, `200=${ok}`);
      check(`总耗时低于串行之和（< 顺序均值 × ${LOGIN_CONCURRENCY} × 0.5，即 scrypt 异步不阻塞事件循环）`, totalMs < seqAvg * LOGIN_CONCURRENCY * 0.5, `总耗时=${totalMs.toFixed(0)}ms, 顺序均值=${seqAvg.toFixed(1)}ms`);
      latencyReport(`POST /api/auth/login 延迟（并发 ${LOGIN_CONCURRENCY}）`, rs.map((r) => r.ms));
    }

    // 任务拉取（队列已空，返回 task:null，测空队列开销）
    times = [];
    for (let i = 0; i < 200; i++) {
      const r = await httpReq('GET', '/api/judge/tasks', { key });
      if (r.status !== 200) { check('任务拉取 GET 全 200', false); break; }
      times.push(r.ms);
    }
    if (times.length === 200) check('任务拉取 GET ×200 全 200', true);
    latencyReport('GET /api/judge/tasks 延迟（空队列）', times);
  }

  console.log('\n===== 场景 6：混合负载冒烟（提交→拉取→回传闭环）=====');
  {
    const M = 100;
    // 提交 M 个 → 全部拉取 → 全部回传，验证无状态错乱
    const subs = await Promise.all(Array.from({ length: M }, () =>
      httpReq('POST', '/api/submissions', { token, body: { problemId: commProblemId, language: 'cpp', sourceCode: 'int Alice(std::string s){return 0;} int Bob(std::string t,int x){return 0;}' } })
    ));
    const subIds = subs.map((r) => r.json.id);
    const pulled = [];
    for (let i = 0; i < M; i++) {
      const r = await httpReq('GET', '/api/judge/tasks', { key });
      pulled.push(r.json.task && r.json.task.id);
    }
    const pulledSet = new Set(pulled);
    const pulledOk = pulledSet.size === M && subIds.every((id) => pulledSet.has(id));
    check(`闭环拉取：${M} 个提交全部被拉取且不重复`, pulledOk);

    const finish = await Promise.all(pulled.map((id, i) =>
      httpReq('POST', '/api/judge/results', { key, body: { submissionId: id, verdict: i % 2 ? 'AC' : 'WA', timeMs: 5, memoryKb: 512 } })
    ));
    const doneCount = db.prepare(`SELECT COUNT(*) AS c FROM submissions WHERE id IN (${subIds.join(',')}) AND status='done'`).get().c;
    check(`闭环回传：${M} 个全部 done`, doneCount === M, `done=${doneCount}`);
    check('闭环回传全部 200', finish.every((r) => r.status === 200));
  }

  server.close();
  console.log(`\n===== 结果：${pass} 通过，${fail} 失败 =====`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('压测运行失败：', e);
  process.exit(1);
});
