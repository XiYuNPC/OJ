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

  // ===== 通信题协议结构校验（类型菜单泛化）=====
  const commProtoBase = {
    title: '协议自测题 ' + Date.now(),
    description: 'x',
    timeLimitMs: 1000,
    memoryLimitMb: 64,
    isCommunication: true,
    testcases: [
      { input: '1\n2\n', expectedOutput: '3\n' },
      { input: '4\n5\n', expectedOutput: '9\n' },
      { input: '7\n8\n', expectedOutput: '15\n' },
    ],
  };
  r = await httpReq('POST', '/api/problems', {
    token: adminToken,
    body: { ...commProtoBase, protocol: 'not-json' },
  });
  check('通信题非法 JSON 协议返回 400', r.status === 400);
  r = await httpReq('POST', '/api/problems', {
    token: adminToken,
    body: { ...commProtoBase, protocol: JSON.stringify({ driver: 'two-phase', fn1: { name: 'f', params: ['blob'], ret: 'int' } }) },
  });
  check('协议参数类型不在菜单返回 400', r.status === 400);
  r = await httpReq('POST', '/api/problems', {
    token: adminToken,
    body: {
      ...commProtoBase,
      protocol: JSON.stringify({ fn1: { name: 'f', params: ['int'], ret: 'int' }, fn2: { name: 'g', params: ['int', 'int'], xParam: 5, ret: 'int' } }),
    },
  });
  check('协议 xParam 越界返回 400', r.status === 400);
  r = await httpReq('POST', '/api/problems', {
    token: adminToken,
    body: {
      ...commProtoBase,
      protocol: JSON.stringify({ fn1: { name: 'f', params: ['int'], ret: 'long long' }, fn2: { name: 'g', params: ['int', 'int'], xParam: 1, ret: 'int' } }),
    },
  });
  check('协议 X 类型与 fn2.params[xParam] 不一致返回 400', r.status === 400);
  r = await httpReq('POST', '/api/problems', {
    token: adminToken,
    body: {
      ...commProtoBase,
      protocol: JSON.stringify({
        driver: 'two-phase',
        fn1: { name: 'sum', params: ['vector<int>'], ret: 'long long' },
        fn2: { name: 'plus', params: ['long long', 'int'], xParam: 0, ret: 'long long' },
        xMax: 1000000000000000000,
      }),
    },
  });
  check('合法新式协议创建返回 201', r.status === 201);
  r = await httpReq('POST', '/api/problems', {
    token: adminToken,
    body: { ...commProtoBase, protocol: JSON.stringify({ driver: 'two-phase', fn1: 'Alice', fn2: 'Bob' }) },
  });
  check('旧式协议（函数名字符串）兼容返回 201', r.status === 201);
  r = await httpReq('POST', '/api/problems', {
    token: adminToken,
    body: { ...commProtoBase, protocol: JSON.stringify({ driver: 'stations', fn1: 'label', fn2: 'find_next_station' }) },
  });
  check('stations 协议创建返回 201', r.status === 201);
  r = await httpReq('POST', '/api/problems', {
    token: adminToken,
    body: {
      ...commProtoBase,
      protocol: JSON.stringify({
        driver: 'two-phase',
        fn1: { name: 'encode', params: ['vector<int>'], ret: 'string' },
        fn2: { name: 'decode', params: ['string'], xParam: 0, ret: 'string' },
        mutate: { type: 'noise-num', ratio: 0.2, seed: 1, min: 0, max: 100 },
      }),
    },
  });
  check('带 mutate（noise-num）的协议创建返回 201', r.status === 201);
  r = await httpReq('POST', '/api/problems', {
    token: adminToken,
    body: {
      ...commProtoBase,
      protocol: JSON.stringify({
        driver: 'two-phase',
        fn1: { name: 'f', params: ['int'], ret: 'int' },
        fn2: { name: 'g', params: ['int', 'int'], xParam: 1, ret: 'int' },
        mutate: { type: 'noise-num', ratio: 0.2, seed: 1, min: 0, max: 10 },
      }),
    },
  });
  check('mutate 但 fn1 返回非 string 返回 400', r.status === 400);
  r = await httpReq('POST', '/api/problems', {
    token: adminToken,
    body: {
      ...commProtoBase,
      protocol: JSON.stringify({
        driver: 'two-phase',
        fn1: { name: 'f', params: ['string'], ret: 'string' },
        fn2: { name: 'g', params: ['string'], xParam: 0, ret: 'string' },
        mutate: { type: 'noise-num', ratio: 1.5, seed: 1, min: 0, max: 10 },
      }),
    },
  });
  check('mutate ratio 非法返回 400', r.status === 400);
  r = await httpReq('POST', '/api/problems', {
    token: adminToken,
    body: {
      ...commProtoBase,
      protocol: JSON.stringify({
        driver: 'two-phase',
        fn1: { name: 'alice', params: ['vector<int>'], ret: 'string' },
        fn2: { name: 'bob', params: ['string'], xParam: 0, ret: 'string' },
        mutate: { type: 'delete-edges', delete: 1, seed: 1 },
      }),
    },
  });
  check('带 mutate（delete-edges）的协议创建返回 201', r.status === 201);
  r = await httpReq('POST', '/api/problems', {
    token: adminToken,
    body: {
      ...commProtoBase,
      protocol: JSON.stringify({
        driver: 'two-phase',
        fn1: { name: 'f', params: ['string'], ret: 'string' },
        fn2: { name: 'g', params: ['string'], xParam: 0, ret: 'string' },
        mutate: { type: 'delete-edges', delete: 0, seed: 1 },
      }),
    },
  });
  check('mutate delete 非法返回 400', r.status === 400);

  // ===== 提交与评测（验收 #5-#8）=====
  r = await httpReq('POST', '/api/submissions', {
    token: memberToken,
    body: { problemId, language: 'cpp', sourceCode: '#include <iostream>\nint main(){int a,b;std::cin>>a>>b;std::cout<<a+b;}' },
  });
  check('会员提交返回 201 且状态 pending', r.status === 201 && r.json.status === 'pending');
  const submissionId = r.json.id;

  // ===== 多语言支持 =====
  r = await httpReq('POST', '/api/submissions', {
    token: memberToken,
    body: { problemId, language: 'python', sourceCode: 'print(sum(map(int, input().split())))' },
  });
  check('提交 Python 语言返回 201', r.status === 201 && r.json.status === 'pending');
  const pySubId = r.json.id;
  r = await httpReq('POST', '/api/submissions', {
    token: memberToken,
    body: { problemId, language: 'go', sourceCode: 'package main' },
  });
  check('不支持的语言返回 400', r.status === 400);

  // 直接按 language=python 过滤拉取（不影响队列里的 cpp 任务，留给后续「凭证拉取任务」断言）
  r = await httpReq('GET', '/api/judge/tasks?language=python', { key: config.judgeApiKey });
  check('任务拉取按 language=python 过滤到 python 任务', r.status === 200 && r.json.task && r.json.task.id === pySubId && r.json.task.language === 'python');
  // 回传 python 任务，恢复队列干净
  r = await httpReq('POST', '/api/judge/results', { key: config.judgeApiKey, body: { submissionId: pySubId, verdict: 'AC', details: [] } });
  check('python 任务回传成功', r.status === 200 && r.json.verdict === 'AC');

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
  r = await httpReq('POST', '/api/submissions', { token: memberToken, body: { problemId: commId, language: 'python', sourceCode: 'print(1)' } });
  check('通信题非 cpp 语言返回 400', r.status === 400);

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

  // 自助认领非 cpp（后端评测机语言）返回 400，浏览器内实时编译仅限 C++
  r = await httpReq('POST', '/api/submissions', {
    token: memberToken,
    body: { problemId, language: 'java', sourceCode: 'public class Main{public static void main(String[] a){}}' },
  });
  check('提交 Java 语言返回 201', r.status === 201);
  const javaSubId = r.json.id;
  r = await httpReq('POST', '/api/judge/self/claim', { token: memberToken, body: { submissionId: javaSubId } });
  check('自助认领非 cpp 语言返回 400', r.status === 400);
  r = await httpReq('GET', '/api/judge/tasks?language=java', { key: config.judgeApiKey });
  check('后端通道按 language=java 拉取 java 任务', r.status === 200 && r.json.task && r.json.task.id === javaSubId);
  r = await httpReq('POST', '/api/judge/results', { key: config.judgeApiKey, body: { submissionId: javaSubId, verdict: 'AC', details: [] } });
  check('java 任务回传成功', r.status === 200);

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

  // ===== 比赛（列表 / 详情 / CRUD / 可见性）=====
  r = await httpReq('GET', '/api/contests');
  check(
    '游客查看比赛列表（含 problemCount 与 status）',
    r.status === 200 && Array.isArray(r.json) && r.json.length >= 2 && r.json.every((c) => 'problemCount' in c && 'status' in c)
  );
  check('种子比赛含进行中一场', r.json.some((c) => c.status === 'ongoing'));

  const contestBody = {
    title: '自测赛 ' + Date.now(),
    description: '自测比赛描述',
    startTime: '2020-01-01 00:00:00',
    endTime: '2020-01-02 00:00:00',
    isPublic: 1,
    problemIds: [problemId],
  };
  r = await httpReq('POST', '/api/contests', { token: adminToken, body: contestBody });
  check('管理员创建比赛返回 201 且含赛题', r.status === 201 && r.json.problems && r.json.problems.length === 1 && r.json.status === 'ended');
  const contestId = r.json.id;
  r = await httpReq('POST', '/api/contests', { token: memberToken, body: contestBody });
  check('会员创建比赛返回 403', r.status === 403);
  r = await httpReq('POST', '/api/contests', { token: adminToken, body: { ...contestBody, title: '时间错乱', endTime: '2020-01-01 00:00:00' } });
  check('结束时间不晚于开始时间返回 400', r.status === 400);
  r = await httpReq('POST', '/api/contests', { token: adminToken, body: { ...contestBody, title: '时间格式错', startTime: 'abc' } });
  check('非法时间格式返回 400', r.status === 400);
  r = await httpReq('POST', '/api/contests', { token: adminToken, body: { ...contestBody, title: '封榜时间合法', freezeTime: '2020-01-01 12:00:00' } });
  check('创建比赛带封榜时间返回 201 且回传 freezeTime', r.status === 201 && r.json.freezeTime === '2020-01-01 12:00:00');
  r = await httpReq('POST', '/api/contests', { token: adminToken, body: { ...contestBody, title: '封榜时间越界', freezeTime: '2019-12-31 00:00:00' } });
  check('封榜时间在区间外返回 400', r.status === 400);
  r = await httpReq('POST', '/api/contests', { token: adminToken, body: { ...contestBody, title: '封榜时间格式错', freezeTime: 'abc' } });
  check('封榜时间格式无效返回 400', r.status === 400);

  r = await httpReq('GET', `/api/contests/${contestId}`);
  check('游客查看比赛详情含赛题', r.status === 200 && Array.isArray(r.json.problems) && r.json.problems[0].id === problemId);

  r = await httpReq('PATCH', `/api/contests/${contestId}`, { token: adminToken, body: { problemIds: [] } });
  check('编辑比赛清空赛题', r.status === 200 && r.json.problems.length === 0);
  r = await httpReq('PATCH', `/api/contests/${contestId}`, { token: adminToken, body: { title: '改名赛' } });
  check('编辑比赛标题', r.status === 200 && r.json.title === '改名赛');
  r = await httpReq('PATCH', `/api/contests/${contestId}`, { token: adminToken, body: {} });
  check('空更新返回 400', r.status === 400);

  // 隐藏比赛：游客不可见，管理员可见
  r = await httpReq('PATCH', `/api/contests/${contestId}`, { token: adminToken, body: { isPublic: false } });
  check('比赛设为隐藏', r.status === 200 && r.json.isPublic === false);
  r = await httpReq('GET', `/api/contests/${contestId}`);
  check('游客不可见隐藏比赛', r.status === 404);
  r = await httpReq('GET', `/api/contests/${contestId}`, { token: adminToken });
  check('管理员可见隐藏比赛', r.status === 200 && r.json.isPublic === false);

  r = await httpReq('DELETE', `/api/contests/${contestId}`, { token: memberToken });
  check('会员删除比赛返回 403', r.status === 403);
  r = await httpReq('DELETE', `/api/contests/${contestId}`, { token: adminToken });
  check('管理员删除比赛成功', r.status === 200 && r.json.ok === true);
  r = await httpReq('GET', `/api/contests/${contestId}`);
  check('删除后比赛不存在', r.status === 404);

  // ===== 比赛内提交 + 实时榜单（ACM 罚时）=====
  const dbTs = (d) => d.toISOString().slice(0, 19).replace('T', ' ');
  const nowD = new Date();
  r = await httpReq('POST', '/api/contests', {
    token: adminToken,
    body: {
      title: '榜单自测赛 ' + Date.now(),
      startTime: dbTs(new Date(nowD.getTime() - 3600e3)),
      endTime: dbTs(new Date(nowD.getTime() + 3600e3)),
      problemIds: [problemId],
    },
  });
  check('创建进行中比赛（用于榜单）', r.status === 201 && r.json.status === 'ongoing');
  const sbContestId = r.json.id;

  r = await httpReq('POST', '/api/submissions', {
    token: memberToken,
    body: { problemId: commId, sourceCode: 'int main(){}', contestId: sbContestId },
  });
  check('提交到不属于比赛的题目返回 400', r.status === 400);

  r = await httpReq('POST', '/api/contests', {
    token: adminToken,
    body: {
      title: '未开始赛 ' + Date.now(),
      startTime: dbTs(new Date(nowD.getTime() + 3600e3)),
      endTime: dbTs(new Date(nowD.getTime() + 7200e3)),
      problemIds: [problemId],
    },
  });
  const upcomingContestId = r.json.id;
  r = await httpReq('POST', '/api/submissions', {
    token: memberToken,
    body: { problemId, sourceCode: 'int main(){}', contestId: upcomingContestId },
  });
  check('未开始比赛提交返回 400', r.status === 400);

  r = await httpReq('POST', '/api/contests', {
    token: adminToken,
    body: {
      title: '已结束赛 ' + Date.now(),
      startTime: dbTs(new Date(nowD.getTime() - 7200e3)),
      endTime: dbTs(new Date(nowD.getTime() - 3600e3)),
      problemIds: [problemId],
    },
  });
  const endedContestId = r.json.id;
  r = await httpReq('POST', '/api/submissions', {
    token: memberToken,
    body: { problemId, sourceCode: 'int main(){}', contestId: endedContestId },
  });
  check('已结束比赛提交返回 400', r.status === 400);

  r = await httpReq('POST', '/api/submissions', {
    token: memberToken,
    body: { problemId, sourceCode: 'int main(){}', contestId: sbContestId },
  });
  check('比赛内提交返回 201 且附 contestId', r.status === 201 && r.json.contestId === sbContestId);
  const sbSubId = r.json.id;

  r = await httpReq('GET', `/api/contests/${sbContestId}/scoreboard`);
  check('评测中比赛榜单为空', r.status === 200 && r.json.rows.length === 0 && r.json.submissions.length === 0);

  r = await httpReq('POST', '/api/judge/self/claim', { token: memberToken, body: { submissionId: sbSubId } });
  check('比赛提交自助认领', r.status === 200 && r.json.submissionId === sbSubId);
  r = await httpReq('POST', '/api/judge/self/results', {
    token: memberToken,
    body: { submissionId: sbSubId, verdict: 'AC', details: [], timeMs: 10, memoryKb: 512 },
  });
  check('比赛提交回传 AC', r.status === 200 && r.json.verdict === 'AC');

  r = await httpReq('GET', `/api/contests/${sbContestId}/scoreboard`);
  const sb = r.json;
  check(
    '榜单含 AC 用户与罚时',
    r.status === 200 && sb.rows.length === 1 && sb.rows[0].solved === 1 && sb.rows[0].penalty >= 59 &&
      sb.rows[0].cells[0].status === 'ac' && sb.rows[0].cells[0].acTime >= 59
  );
  check('榜单附滚榜用的提交序列', Array.isArray(sb.submissions) && sb.submissions.length === 1);

  r = await httpReq('POST', '/api/submissions', {
    token: memberToken,
    body: { problemId, sourceCode: 'int main(){}' },
  });
  r = await httpReq('GET', `/api/contests/${sbContestId}/scoreboard`);
  check('非比赛提交不计入榜单', r.status === 200 && r.json.rows.length === 1);

  r = await httpReq('GET', `/api/submissions?contestId=${sbContestId}`);
  check('按比赛过滤提交列表', r.status === 200 && Array.isArray(r.json) && r.json.length === 1 && r.json[0].contestId === sbContestId);

  // ===== 比赛补强：非法赛题 id、榜单口径（CE / 罚时 / AC 后忽略 / 排序 / 滚榜序列）=====
  r = await httpReq('POST', '/api/contests', {
    token: adminToken,
    body: { ...contestBody, title: '非法赛题赛 ' + Date.now(), problemIds: [999999] },
  });
  check('创建比赛含不存在题目返回 400', r.status === 400 && String(r.json && r.json.error).includes('不存在'));
  r = await httpReq('PATCH', `/api/contests/${sbContestId}`, { token: adminToken, body: { problemIds: [999999] } });
  check('编辑比赛含不存在题目返回 400', r.status === 400 && String(r.json && r.json.error).includes('不存在'));

  r = await httpReq('GET', `/api/contests/${upcomingContestId}/scoreboard`);
  check('未开始比赛榜单可见且为空', r.status === 200 && r.json.rows.length === 0 && r.json.submissions.length === 0);
  r = await httpReq('GET', `/api/contests/${endedContestId}/scoreboard`);
  check('已结束比赛榜单可见', r.status === 200 && Array.isArray(r.json.rows));

  // 第二个会员：CE 不计罚时但计尝试、WA→AC 罚时含 20×错误次数、AC 后提交忽略
  const username2 = 'tester2_' + Date.now();
  await httpReq('POST', '/api/auth/register', { body: { username: username2, password: 'pass123456' } });
  r = await httpReq('POST', '/api/auth/login', { body: { username: username2, password: 'pass123456' } });
  const token2 = r.json.token;
  const submitAs = async (token, verdict) => {
    const s = await httpReq('POST', '/api/submissions', {
      token,
      body: { problemId, sourceCode: 'int main(){}', contestId: sbContestId },
    });
    await httpReq('POST', '/api/judge/self/claim', { token, body: { submissionId: s.json.id } });
    await httpReq('POST', '/api/judge/self/results', {
      token,
      body: { submissionId: s.json.id, verdict, details: [], timeMs: 10, memoryKb: 512 },
    });
    return s.json.id;
  };
  const sbRow = (r2, name) => r2.json.rows.find((x) => x.username === name);

  await submitAs(token2, 'CE');
  r = await httpReq('GET', `/api/contests/${sbContestId}/scoreboard`);
  const ceCell = sbRow(r, username2).cells[0];
  check('CE 不计罚时但计尝试', r.status === 200 && ceCell.status === 'tried' && ceCell.wrong === 0 && ceCell.attempts === 1);

  await submitAs(token2, 'WA');
  await submitAs(token2, 'AC');
  r = await httpReq('GET', `/api/contests/${sbContestId}/scoreboard`);
  const acCell = sbRow(r, username2).cells[0];
  check(
    'WA→AC 罚时 = 首 AC 分钟 + 20×错误次数',
    acCell.status === 'ac' && acCell.wrong === 1 && acCell.attempts === 3 && sbRow(r, username2).penalty === acCell.acTime + 20
  );

  // demo 也 WA→AC，与 username2 罚时相同（都 1 错），按最近 AC 时间先后排序
  await submitAs(demoToken, 'WA');
  await submitAs(demoToken, 'AC');

  await submitAs(token2, 'WA'); // AC 后再次提交：不计分、不累加错误
  r = await httpReq('GET', `/api/contests/${sbContestId}/scoreboard`);
  const after = sbRow(r, username2);
  check('AC 后提交不再计分', after.cells[0].attempts === 3 && after.cells[0].wrong === 1 && after.solved === 1);
  check(
    '三人排序：AC 数相同 → 罚时少者前；罚时同 → 最近 AC 早者前',
    r.json.rows.map((x) => x.username).join(',') === [username, 'demo', username2].join(',')
  );
  check('滚榜提交序列完整（含 AC 后提交，共 7 条）', r.json.submissions.length === 7);

  // ===== 比赛通知（公告：读公开、写仅管理员、隐藏比赛与详情同口径）=====
  r = await httpReq('GET', `/api/contests/${sbContestId}/announcements`);
  check('游客查看通知列表为空', r.status === 200 && Array.isArray(r.json) && r.json.length === 0);
  r = await httpReq('POST', `/api/contests/${sbContestId}/announcements`, {
    token: memberToken,
    body: { title: '会员发布', content: '' },
  });
  check('会员发布通知返回 403', r.status === 403);

  r = await httpReq('POST', `/api/contests/${sbContestId}/announcements`, {
    token: adminToken,
    body: { title: '  系统提示  ', content: '  维护通知  ' },
  });
  check('管理员发布通知返回 201 且首尾空格去除', r.status === 201 && r.json.title === '系统提示' && r.json.content === '维护通知' && r.json.author === 'admin');
  const annId = r.json.id;
  r = await httpReq('GET', `/api/contests/${sbContestId}/announcements`);
  check('通知列表含新通知', r.status === 200 && r.json.length === 1 && r.json[0].id === annId);

  r = await httpReq('POST', `/api/contests/${sbContestId}/announcements`, {
    token: adminToken,
    body: { title: '   ', content: 'x' },
  });
  check('空标题通知返回 400', r.status === 400);
  r = await httpReq('POST', `/api/contests/${sbContestId}/announcements`, {
    token: adminToken,
    body: { title: 'x', content: 'x'.repeat(5001) },
  });
  check('超长内容通知返回 400', r.status === 400);

  r = await httpReq('PATCH', `/api/contests/${sbContestId}/announcements/${annId}`, {
    token: memberToken,
    body: { title: '篡改' },
  });
  check('会员编辑通知返回 403', r.status === 403);
  r = await httpReq('PATCH', `/api/contests/${sbContestId}/announcements/${annId}`, {
    token: adminToken,
    body: { content: '改后的内容' },
  });
  check('管理员编辑通知生效', r.status === 200 && r.json.ok === true);
  r = await httpReq('GET', `/api/contests/${sbContestId}/announcements`);
  check('编辑后内容已更新', r.status === 200 && r.json[0].title === '系统提示' && r.json[0].content === '改后的内容');
  r = await httpReq('PATCH', `/api/contests/${sbContestId}/announcements/${annId}`, {
    token: adminToken,
    body: {},
  });
  check('空更新通知返回 400', r.status === 400);
  r = await httpReq('GET', '/api/contests/999999/announcements');
  check('不存在比赛的通知列表返回 404', r.status === 404);

  r = await httpReq('DELETE', `/api/contests/${sbContestId}/announcements/${annId}`, { token: memberToken });
  check('会员删除通知返回 403', r.status === 403);
  r = await httpReq('DELETE', `/api/contests/${sbContestId}/announcements/${annId}`, { token: adminToken });
  check('管理员删除通知成功', r.status === 200 && r.json.ok === true);
  r = await httpReq('GET', `/api/contests/${sbContestId}/announcements`);
  check('删除后通知列表为空', r.status === 200 && r.json.length === 0);

  // 隐藏比赛的通知与比赛本身同口径：游客 404、管理员可见
  r = await httpReq('POST', '/api/contests', {
    token: adminToken,
    body: { ...contestBody, title: '隐藏通知赛 ' + Date.now(), isPublic: false },
  });
  const hiddenAnnContestId = r.json.id;
  await httpReq('POST', `/api/contests/${hiddenAnnContestId}/announcements`, {
    token: adminToken,
    body: { title: '内部通知', content: '' },
  });
  r = await httpReq('GET', `/api/contests/${hiddenAnnContestId}/announcements`);
  check('隐藏比赛通知游客返回 404', r.status === 404);
  r = await httpReq('GET', `/api/contests/${hiddenAnnContestId}/announcements`, { token: adminToken });
  check('隐藏比赛通知管理员可见', r.status === 200 && r.json.length === 1);

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
