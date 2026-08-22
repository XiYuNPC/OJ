// 接口自测脚本（不依赖外部网络）：node scripts/test.js（npm test）
// 使用内存 SQLite 与随机端口，覆盖验收标准 #1-#8、#14 的关键接口行为
process.env.DB_PATH = ':memory:';

const http = require('http');
const db = require('../server/db');
const app = require('../server/app');
const config = require('../server/config');
const ws = require('../server/ws');
require('./seed'); // 内存库中注入演示数据（幂等）

const server = http.createServer(app);
ws.init(server);

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    fail += 1;
    console.error(`  ✗ ${name}${extra ? ' — ' + extra : ''}`);
  }
}

// 基于 http 模块的请求封装（兼容 Node 16+，无需 fetch）
function httpReq(method, path, { token, key, body } = {}) {
  return new Promise((resolve, reject) => {
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    if (key) headers['x-judge-key'] = key;
    const payload = body === undefined ? null : JSON.stringify(body);
    if (payload !== null) headers['Content-Type'] = 'application/json';
    const req = http.request(
      { host: '127.0.0.1', port: server.address().port, path, method, headers },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          let json = null;
          try {
            json = JSON.parse(data);
          } catch (e) {}
          resolve({ status: res.statusCode, json });
        });
      }
    );
    req.on('error', reject);
    if (payload !== null) req.write(payload);
    req.end();
  });
}

async function main() {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));

  // ===== 准备：注册 + 登录 =====
  const username = 'tester_' + Date.now();
  let r = await httpReq('POST', '/api/auth/register', { body: { username, password: 'pass123456' } });
  check('注册新会员返回 201', r.status === 201 && r.json.role === 'member');
  r = await httpReq('POST', '/api/auth/register', { body: { username, password: 'pass123456' } });
  check('重复用户名注册返回 409', r.status === 409);
  r = await httpReq('POST', '/api/auth/register', { body: { username: 'ab', password: 'pass123456' } });
  check('非法用户名返回 400', r.status === 400);

  r = await httpReq('POST', '/api/auth/login', { body: { username, password: 'pass123456' } });
  check('登录返回 JWT', r.status === 200 && typeof r.json.token === 'string');
  const memberToken = r.json.token;
  r = await httpReq('POST', '/api/auth/login', { body: { username, password: 'wrong-pass' } });
  check('错误密码登录返回 401', r.status === 401);

  r = await httpReq('POST', '/api/auth/login', { body: { username: 'admin', password: 'admin123' } });
  check('管理员登录成功', r.status === 200 && r.json.user.role === 'admin');
  const adminToken = r.json.token;

  // ===== 游客边界（验收 #2）=====
  r = await httpReq('GET', '/api/problems', { token: memberToken });
  check('题目列表（已上架）可访问', r.status === 200 && Array.isArray(r.json));
  r = await httpReq('POST', '/api/submissions', { body: { problemId: 1, sourceCode: 'int main(){}' } });
  check('游客提交返回 401', r.status === 401);
  r = await httpReq('GET', '/api/submissions');
  check('游客查看提交列表（全部提交可见）', r.status === 200 && Array.isArray(r.json));
  r = await httpReq('GET', '/api/admin/users', { token: memberToken });
  check('会员访问后台返回 403', r.status === 403);

  // ===== 管理员建题（验收 #3、#4）=====
  const problemBody = {
    title: '自测题 ' + Date.now(),
    description: '输出 a+b',
    timeLimitMs: 1000,
    memoryLimitMb: 64,
    solution: '题解内容',
    solutionVisible: 1,
    testcases: [
      { input: '1 2\n', expectedOutput: '3\n' },
      { input: '2 3\n', expectedOutput: '5\n' },
      { input: '4 5\n', expectedOutput: '9\n' },
    ],
  };
  r = await httpReq('POST', '/api/problems', { token: adminToken, body: problemBody });
  check('管理员建题返回 201', r.status === 201);
  const problemId = r.json.id;
  r = await httpReq('POST', '/api/problems', {
    token: adminToken,
    body: { ...problemBody, title: '两组数据题', testcases: problemBody.testcases.slice(0, 2) },
  });
  check('少于 3 组测试数据拒绝保存', r.status === 400);
  r = await httpReq('POST', '/api/problems', { token: memberToken, body: problemBody });
  check('会员建题返回 403', r.status === 403);

  // 会员可见测试数据，游客不可见（验收 #2、#10 前提）
  r = await httpReq('GET', `/api/problems/${problemId}`, { token: memberToken });
  check('会员详情含测试数据', r.status === 200 && Array.isArray(r.json.testcases) && r.json.testcases.length === 3);
  r = await httpReq('GET', `/api/problems/${problemId}`);
  check('游客详情不含测试数据', r.status === 200 && !('testcases' in r.json));

  // 上下架与题解隐藏区（验收 #3）
  r = await httpReq('PATCH', `/api/problems/${problemId}`, {
    token: adminToken,
    body: { isPublished: false, solutionVisible: false },
  });
  check('下架并隐藏题解成功', r.status === 200 && r.json.isPublished === false);
  r = await httpReq('GET', `/api/problems/${problemId}`, { token: memberToken });
  check('下架后会员不可见', r.status === 404);
  r = await httpReq('GET', `/api/problems/${problemId}`, { token: adminToken });
  check('管理员可见下架题目', r.status === 200 && r.json.isPublished === false);
  r = await httpReq('PATCH', `/api/problems/${problemId}`, { token: adminToken, body: { isPublished: true } });
  check('重新上架成功', r.status === 200 && r.json.isPublished === true);

  // ===== 提交与评测（验收 #5-#8）=====
  r = await httpReq('POST', '/api/submissions', {
    token: memberToken,
    body: { problemId, language: 'cpp', sourceCode: '#include <iostream>\nint main(){int a,b;std::cin>>a>>b;std::cout<<a+b;}' },
  });
  check('会员提交返回 201 且状态 pending', r.status === 201 && r.json.status === 'pending');
  const submissionId = r.json.id;

  r = await httpReq('GET', '/api/judge/tasks');
  check('无凭证拉取任务返回 401', r.status === 401);
  r = await httpReq('GET', '/api/judge/tasks', { key: 'wrong-key' });
  check('错误凭证拉取任务返回 401', r.status === 401);

  r = await httpReq('GET', '/api/judge/tasks', { key: config.judgeApiKey });
  check(
    '凭证拉取到任务（含源码与测试数据）',
    r.status === 200 && r.json.task && r.json.task.id === submissionId && r.json.task.sourceCode.includes('main') && r.json.task.testcases.length === 3
  );
  r = await httpReq('GET', '/api/judge/tasks', { key: config.judgeApiKey });
  check('评测中任务不重复发放（队列 FIFO 空）', r.status === 200 && r.json.task === null);

  r = await httpReq('POST', '/api/judge/results', {
    key: config.judgeApiKey,
    body: { submissionId, verdict: 'AC', details: [{ ordinal: 1, ok: true }], timeMs: 12, memoryKb: 1024 },
  });
  check('结果回传 AC 成功', r.status === 200 && r.json.verdict === 'AC');
  r = await httpReq('POST', '/api/judge/results', {
    key: config.judgeApiKey,
    body: { submissionId, verdict: 'WA' },
  });
  check('重复回传幂等返回原判定', r.status === 200 && r.json.verdict === 'AC');

  r = await httpReq('GET', `/api/submissions/${submissionId}`, { token: memberToken });
  check('本人查询提交详情为 AC（未传 isPublic 默认公开）', r.status === 200 && r.json.status === 'done' && r.json.verdict === 'AC' && Array.isArray(r.json.details) && r.json.isPublic === 1);
  r = await httpReq('GET', `/api/submissions/${submissionId}`, { token: adminToken });
  check('管理员查询提交详情成功', r.status === 200 && r.json.verdict === 'AC');
  r = await httpReq('GET', '/api/submissions', { token: memberToken });
  check('会员可见提交列表（含他人）', r.status === 200 && Array.isArray(r.json) && r.json.length >= 1);

  // 代码可见性边界：公开/未公开 × 本人/他人/游客
  r = await httpReq('POST', '/api/auth/login', { body: { username: 'demo', password: 'demo123' } });
  const demoToken = r.json.token;
  r = await httpReq('GET', `/api/submissions/${submissionId}`, { token: demoToken });
  check('他人可看公开提交详情（代码可见）', r.status === 200 && typeof r.json.sourceCode === 'string' && r.json.isPublic === 1);
  r = await httpReq('GET', `/api/submissions/${submissionId}`);
  check('游客可看公开提交详情（代码可见）', r.status === 200 && typeof r.json.sourceCode === 'string');

  // 提交未公开代码（isPublic: 0），评测完成后验证：结果人人可见、代码仅本人可见
  r = await httpReq('POST', '/api/submissions', {
    token: memberToken,
    body: { problemId, language: 'cpp', sourceCode: 'int main(){}', isPublic: 0 },
  });
  check('提交 isPublic=0 返回 201', r.status === 201);
  const privateId = r.json.id;
  r = await httpReq('GET', '/api/judge/tasks', { key: config.judgeApiKey });
  check('未公开提交进入评测队列（FIFO）', r.status === 200 && r.json.task && r.json.task.id === privateId);
  r = await httpReq('POST', '/api/judge/results', {
    key: config.judgeApiKey,
    body: { submissionId: privateId, verdict: 'WA' },
  });
  check('未公开提交回传 WA 成功', r.status === 200 && r.json.verdict === 'WA');
  r = await httpReq('GET', `/api/submissions/${privateId}`, { token: memberToken });
  check('本人可见自己未公开提交的代码', r.status === 200 && typeof r.json.sourceCode === 'string' && r.json.isPublic === 0 && r.json.verdict === 'WA');
  r = await httpReq('GET', `/api/submissions/${privateId}`, { token: demoToken });
  check('他人看未公开提交：代码隐藏、结果可见', r.status === 200 && r.json.sourceCode === null && r.json.verdict === 'WA');
  r = await httpReq('GET', `/api/submissions/${privateId}`);
  check('游客看未公开提交：代码隐藏、结果可见', r.status === 200 && r.json.sourceCode === null && r.json.verdict === 'WA');

  // 题目内提交记录（按题过滤）
  r = await httpReq('GET', `/api/submissions?problemId=${problemId}`);
  check('按题过滤提交列表', r.status === 200 && Array.isArray(r.json) && r.json.length >= 2 && r.json.every((s) => s.problemId === problemId));
  r = await httpReq('GET', '/api/submissions?problemId=abc');
  check('非法 problemId 返回 400', r.status === 400);

  // 通信题已开放提交
  const commId = db.prepare(`SELECT id FROM problems WHERE is_communication = 1`).get().id;
  r = await httpReq('POST', '/api/submissions', { token: memberToken, body: { problemId: commId, sourceCode: 'int Alice(std::string s){return 0;}' } });
  check('通信题提交返回 201（已开放）', r.status === 201);

  // ===== 自助评测通道（纯前端评测机，JWT 鉴权、仅限本人）=====
  r = await httpReq('POST', '/api/submissions', {
    token: memberToken,
    body: { problemId, language: 'cpp', sourceCode: 'int main(){return 0;}' },
  });
  check('自助通道：提交新代码成功', r.status === 201);
  const selfId = r.json.id;

  r = await httpReq('POST', '/api/judge/self/claim', { body: { submissionId: selfId } });
  check('自助认领：游客返回 401', r.status === 401);
  r = await httpReq('POST', '/api/judge/self/claim', { token: demoToken, body: { submissionId: selfId } });
  check('自助认领：他人提交返回 403', r.status === 403);
  r = await httpReq('POST', '/api/judge/self/claim', { token: memberToken, body: { submissionId: selfId } });
  check(
    '自助认领：本人认领成功返回任务包（源码+限制+测试数据）',
    r.status === 200 && r.json.submissionId === selfId && r.json.sourceCode.includes('main') &&
      r.json.timeLimitMs === 1000 && r.json.memoryLimitMb === 64 && r.json.testcases.length === 3
  );
  r = await httpReq('POST', '/api/judge/self/claim', { token: memberToken, body: { submissionId: selfId } });
  check('自助认领：judging 状态可重复认领（中断恢复）', r.status === 200 && r.json.submissionId === selfId);
  r = await httpReq('POST', '/api/judge/self/claim', { token: memberToken, body: { submissionId } });
  check('自助认领：已评测完成返回 400', r.status === 400);
  r = await httpReq('POST', '/api/judge/self/claim', { token: memberToken, body: { submissionId: 99999 } });
  check('自助认领：不存在的提交返回 404', r.status === 404);

  r = await httpReq('POST', '/api/judge/self/results', {
    token: demoToken,
    body: { submissionId: selfId, verdict: 'AC' },
  });
  check('自助回传：他人提交返回 403', r.status === 403);
  r = await httpReq('POST', '/api/judge/self/results', {
    token: memberToken,
    body: {
      submissionId: selfId, verdict: 'WA',
      details: [{ ordinal: 1, ok: true }, { ordinal: 2, ok: false }], timeMs: 8, memoryKb: 512,
    },
  });
  check('自助回传：本人回传 WA 成功', r.status === 200 && r.json.verdict === 'WA');
  r = await httpReq('GET', `/api/submissions/${selfId}`, { token: memberToken });
  check(
    '自助回传：提交详情已更新（WA + 明细 + 耗时内存）',
    r.status === 200 && r.json.status === 'done' && r.json.verdict === 'WA' &&
      r.json.details.length === 2 && r.json.timeMs === 8 && r.json.memoryKb === 512
  );
  r = await httpReq('POST', '/api/judge/self/results', {
    token: memberToken,
    body: { submissionId: selfId, verdict: 'AC' },
  });
  check('自助回传：重复回传幂等返回原判定', r.status === 200 && r.json.verdict === 'WA');
  r = await httpReq('POST', '/api/judge/self/results', {
    token: memberToken,
    body: { submissionId: selfId, verdict: 'PE' },
  });
  check('自助回传：非法 verdict 返回 400', r.status === 400);

  r = await httpReq('POST', '/api/submissions', {
    token: memberToken,
    body: { problemId, language: 'cpp', sourceCode: 'int main(){}' },
  });
  const pendingSelfId = r.json.id;
  r = await httpReq('POST', '/api/judge/self/results', {
    token: memberToken,
    body: { submissionId: pendingSelfId, verdict: 'AC' },
  });
  check('自助回传：未认领（pending）提交返回 409', r.status === 409);

  // 通信题提交走自助通道（从库中直插一条模拟历史提交）
  const commUser = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  const commSub = db
    .prepare('INSERT INTO submissions (problem_id, user_id, language, source_code) VALUES (?, ?, ?, ?)')
    .run(commId, commUser.id, 'cpp', 'int Alice(std::string s){return 0;} int Bob(std::string t,int x){return 0;}');
  r = await httpReq('POST', '/api/judge/self/claim', { token: memberToken, body: { submissionId: Number(commSub.lastInsertRowid) } });
  check('自助认领：通信题返回 200 且含 protocol', r.status === 200 && r.json.isCommunication === true && r.json.protocol && typeof r.json.protocol === 'object');

  // ===== 后台用户管理 =====
  r = await httpReq('GET', '/api/admin/users', { token: adminToken });
  check('管理员查看用户列表', r.status === 200 && Array.isArray(r.json));
  const target = r.json.find((u) => u.username === username);
  r = await httpReq('PATCH', `/api/admin/users/${target.id}/role`, { token: adminToken, body: { role: 'admin' } });
  check('调整用户角色为 admin', r.status === 200 && r.json.role === 'admin');
  r = await httpReq('PATCH', `/api/admin/users/${target.id}/role`, { token: adminToken, body: { role: 'member' } });
  check('调整用户角色回 member', r.status === 200 && r.json.role === 'member');
  r = await httpReq('PATCH', '/api/admin/users/1/role', { token: adminToken, body: { role: 'member' } });
  check('不能修改自己的角色', r.status === 400);

  // ===== 接口文档（验收 #14）=====
  r = await httpReq('GET', '/api/docs');
  check('接口文档可访问', r.status === 200);

  server.close();
  console.log(`\n结果：${pass} 通过，${fail} 失败`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('自测运行失败：', e);
  process.exit(1);
});
