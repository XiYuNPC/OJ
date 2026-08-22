// 演示数据（幂等）：演示账号 + 样例题目（A+B、4 组测试数据）+ 一道通信题示例
// 用法：node scripts/seed.js（npm run seed）
const crypto = require('crypto');
const db = require('../server/db');

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

function ensureUser(username, password, role) {
  const exists = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (exists) return Number(exists.id);
  const salt = crypto.randomBytes(16).toString('hex');
  const info = db
    .prepare('INSERT INTO users (username, password_hash, salt, role) VALUES (?, ?, ?, ?)')
    .run(username, hashPassword(password, salt), salt, role);
  return Number(info.lastInsertRowid);
}

function ensureProblem(adminId, data, testcases) {
  let problemId;
  const bg = data.background || '';
  const ifmt = data.input_format || '';
  const ofmt = data.output_format || '';
  const hint = data.hint || '';
  const exists = db.prepare('SELECT id FROM problems WHERE title = ?').get(data.title);
  if (exists) {
    problemId = Number(exists.id);
    // 已存在：刷新题面与限制到最新定义（幂等）
    db.prepare(
      `UPDATE problems SET description = ?, background = ?, input_format = ?, output_format = ?, hint = ?,
              time_limit_ms = ?, memory_limit_mb = ?, solution = ?,
              solution_visible = ?, is_published = ?, is_communication = ?, protocol = ?, updated_at = datetime('now')
       WHERE id = ?`
    ).run(
      data.description, bg, ifmt, ofmt, hint, data.timeLimitMs, data.memoryLimitMb, data.solution,
      data.solution_visible, data.is_published, data.is_communication, data.protocol, problemId
    );
  } else {
    const info = db
      .prepare(
        `INSERT INTO problems (title, description, background, input_format, output_format, hint,
                                time_limit_ms, memory_limit_mb, solution, solution_visible,
                                is_published, is_communication, protocol, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        data.title, data.description, bg, ifmt, ofmt, hint, data.timeLimitMs, data.memoryLimitMb, data.solution,
        data.solution_visible, data.is_published, data.is_communication, data.protocol, adminId
      );
    problemId = Number(info.lastInsertRowid);
  }
  // 测试数据整体替换（幂等）
  db.prepare('DELETE FROM testcases WHERE problem_id = ?').run(problemId);
  const insTc = db.prepare(
    'INSERT INTO testcases (problem_id, ordinal, input, expected_output, is_sample) VALUES (?, ?, ?, ?, ?)'
  );
  testcases.forEach((tc, i) => insTc.run(problemId, i + 1, tc.input, tc.expectedOutput, tc.isSample ? 1 : 0));
  return problemId;
}

const adminId = ensureUser('admin', 'admin123', 'admin');
ensureUser('demo', 'demo123', 'member');

ensureProblem(
  adminId,
  {
    title: 'A+B Problem',
    background: '',
    description: '读入两个整数 a 与 b（|a|, |b| ≤ 2×10^9，a + b 可能超出 32 位 int 范围），输出它们的和。',
    input_format: '一行两个整数，空格分隔。',
    output_format: '一行一个整数，表示 a + b 的值。',
    hint:
      '注意使用 64 位整数（long long）：当 |a|、|b| 均取到 2×10^9 时，a + b = 4×10^9 会超出 32 位 int 的上限（约 2.1×10^9），用 int 会溢出得到错误结果。',
    timeLimitMs: 1000,
    memoryLimitMb: 64,
    solution: '直接输出 a + b 即可。注意使用 64 位整数（long long）。',
    solution_visible: 1,
    is_published: 1,
    is_communication: 0,
    protocol: null,
  },
  [
    { input: '1 2\n', expectedOutput: '3\n', isSample: 1 },
    { input: '10 -5\n', expectedOutput: '5\n', isSample: 1 },
    { input: '100 200\n', expectedOutput: '300\n' },
    // 边界：|a|,|b| = 2×10^9 时 a+b = 4×10^9，超出 32 位 int 上限（约 2.1×10^9），
    // 用 int 会溢出得到错误结果从而 WA；用 long long 正确输出 4000000000 才能 AC。
    { input: '2000000000 2000000000\n', expectedOutput: '4000000000\n' },
  ]
);

// 通信题示例：P12509 两进程函数式通信题
// 旧版「猜数字（交互器）」题若存在则原地升级（保留题目 id 与提交历史）
function ensureCommunicationProblem(adminId) {
  const data = {
    title: 'P12509 通信题',
    description:
      '【通信题】给定两个长度相等（不超过 10^6）且至多一个位置字符不同的 01 串 S 与 T（下标从 1 开始）。\n' +
      'Alice 只知道 S，Bob 只知道 T。Alice 可以传给 Bob 一个整数 X ∈ [0, 2^20)。Bob 需要确定 S、T 字符不同的位置；如果 S = T，返回 0。\n\n' +
      '你需要实现以下两个函数（不要实现 main，评测驱动会自动调用）：\n' +
      '  int Alice(std::string S);      // 返回传给 Bob 的整数 X ∈ [0, 2^20)\n' +
      '  int Bob(std::string T, int X); // 返回不同位置 P ∈ [0, N]；S = T 时返回 0\n\n' +
      '评测方式（两进程）：第一次运行调用 Alice 得到 X 后程序退出；第二次重新运行，以 X 为输入调用 Bob 得到 P，与标准输出比对判定。两次运行相互独立，不能通过全局变量传递信息。\n\n' +
      '样例：S = 0101011，T = 0100011，Bob 返回 4。\n\n' +
      '来源：https://scg3.piaoztsdy.cn/p/14（改编为两进程评测协议）。',
    timeLimitMs: 1000,
    memoryLimitMb: 64,
    solution:
      'Alice 把 S 中所有为 1 的位置编号异或起来得到 X；Bob 对 T 做同样计算得到 Y，返回 X ^ Y。S 与 T 至多一位不同，异或结果恰为不同位置；S = T 时 X ^ Y = 0。',
    solution_visible: 1,
    is_published: 1,
    is_communication: 1,
    protocol: JSON.stringify({
      driver: 'two-phase',
      fn1: 'Alice',
      fn2: 'Bob',
      xMax: 1048575, // 2^20 - 1
      maxIntermediateBytes: 1024,
    }),
  };
  const testcases = [
    { input: '0101011\n0100011\n', expectedOutput: '4\n' },
    { input: '1010\n1110\n', expectedOutput: '2\n' },
    { input: '111\n111\n', expectedOutput: '0\n' },
    { input: '1000000000\n1000000001\n', expectedOutput: '10\n' },
  ];

  let problemId;
  const legacy = db.prepare(`SELECT id FROM problems WHERE title = '猜数字（通信题示例）'`).get();
  if (legacy) {
    problemId = Number(legacy.id);
    db.prepare(
      `UPDATE problems SET title = ?, description = ?, time_limit_ms = ?, memory_limit_mb = ?, solution = ?,
              solution_visible = ?, is_published = ?, is_communication = ?, protocol = ?, updated_at = datetime('now')
       WHERE id = ?`
    ).run(
      data.title, data.description, data.timeLimitMs, data.memoryLimitMb, data.solution,
      data.solution_visible, data.is_published, data.is_communication, data.protocol, problemId
    );
    db.prepare('DELETE FROM testcases WHERE problem_id = ?').run(problemId);
  } else {
    const exists = db.prepare('SELECT id FROM problems WHERE title = ?').get(data.title);
    if (exists) return Number(exists.id);
    const info = db
      .prepare(
        `INSERT INTO problems (title, description, time_limit_ms, memory_limit_mb, solution, solution_visible,
                                is_published, is_communication, protocol, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        data.title, data.description, data.timeLimitMs, data.memoryLimitMb, data.solution,
        data.solution_visible, data.is_published, data.is_communication, data.protocol, adminId
      );
    problemId = Number(info.lastInsertRowid);
  }
  const insTc = db.prepare(
    'INSERT INTO testcases (problem_id, ordinal, input, expected_output) VALUES (?, ?, ?, ?)'
  );
  testcases.forEach((tc, i) => insTc.run(problemId, i + 1, tc.input, tc.expectedOutput));
  return problemId;
}

ensureCommunicationProblem(adminId);

console.log('演示数据已就绪：');
console.log('  会员账号：demo / demo123');
console.log('  管理员账号：admin / admin123');
console.log('  样例题目：A+B Problem（4 组测试数据，含 int 溢出边界）、P12509 通信题（两进程函数式）');
