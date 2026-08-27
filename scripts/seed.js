// 演示数据（幂等）：演示账号 + 样例题目（A+B、P12509 通信题、P6838 网络站点、数组求和接力、B3790 文本压缩、P9165 意外、P10539 魔术表演）+ 样例比赛
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
    solution:
      '直接输出 `a + b` 即可，注意使用 64 位整数：\n\n' +
      '```cpp\n' +
      '#include <iostream>\n' +
      'int main() { long long a, b; std::cin >> a >> b; std::cout << a + b; }\n' +
      '```',
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
      '**思路**：Alice 把 S 中所有为 1 的位置编号异或起来得到 X；Bob 对 T 做同样计算得到 Y，返回 X ^ Y。S 与 T 至多一位不同，异或结果恰为不同位置；S = T 时 X ^ Y = 0。\n\n' +
      '```cpp\n' +
      '#include <bits/stdc++.h>\n' +
      'int Alice(std::string S) {\n' +
      '  int x = 0;\n' +
      '  for (int i = 0; i < (int)S.size(); i++)\n' +
      '    if (S[i] == \'1\') x ^= (i + 1);\n' +
      '  return x;\n' +
      '}\n' +
      'int Bob(std::string T, int X) {\n' +
      '  int y = 0;\n' +
      '  for (int i = 0; i < (int)T.size(); i++)\n' +
      '    if (T[i] == \'1\') y ^= (i + 1);\n' +
      '  return X ^ y;\n' +
      '}\n' +
      '```',
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
    { input: '0101011\n0100011\n', expectedOutput: '4\n', isSample: 1 },
    { input: '1010\n1110\n', expectedOutput: '2\n', isSample: 1 },
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
  } else {
    const exists = db.prepare('SELECT id FROM problems WHERE title = ?').get(data.title);
    if (exists) {
      problemId = Number(exists.id);
      // 已存在：刷新题面与限制到最新定义（幂等）
      db.prepare(
        `UPDATE problems SET description = ?, time_limit_ms = ?, memory_limit_mb = ?, solution = ?,
                solution_visible = ?, is_published = ?, is_communication = ?, protocol = ?, updated_at = datetime('now')
         WHERE id = ?`
      ).run(
        data.description, data.timeLimitMs, data.memoryLimitMb, data.solution,
        data.solution_visible, data.is_published, data.is_communication, data.protocol, problemId
      );
    } else {
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
  }
  // 测试数据整体替换（幂等，与 ensureProblem 一致）
  db.prepare('DELETE FROM testcases WHERE problem_id = ?').run(problemId);
  const insTc = db.prepare(
    'INSERT INTO testcases (problem_id, ordinal, input, expected_output, is_sample) VALUES (?, ?, ?, ?, ?)'
  );
  testcases.forEach((tc, i) => insTc.run(problemId, i + 1, tc.input, tc.expectedOutput, tc.isSample ? 1 : 0));
  return problemId;
}

ensureCommunicationProblem(adminId);

// 通信题示例：P6838 [IOI 2020] 网络站点（stations driver：数组参数 + 数组返回 + 内置 grader）
// 与 ensureCommunicationProblem 同一幂等模式（按标题匹配，已存在则刷新题面与限制）
function ensureStationsProblem(adminId) {
  const data = {
    title: 'P6838 网络站点',
    description:
      '【通信题】新加坡的互联网主干网由 n 个网络站点和 n-1 条双向链路构成，站点之间的链路组成一棵树。\n' +
      '请给每个站点分配一个互不相同的编号（每个编号都是 0..k 之间的整数）。评测系统随后会模拟若干次消息传递：\n' +
      '给定起点站点 z 与终点站点 y，消息从 z 出发沿 z 到 y 的唯一路径前进；消息到达站点 v 时，v 只知道自己的编号、\n' +
      '终点站点的编号、以及自己所有邻居的编号，并据此决定把消息转发给哪一个邻居。\n\n' +
      '你需要实现以下两个函数（不要实现 main，评测驱动会自动调用）：\n' +
      '  std::vector<int> label(int n, int k, std::vector<int> u, std::vector<int> v);\n' +
      '      // 第 i 条边连接站点 u[i] 与 v[i]；返回长度恰为 n 的数组，第 i 个元素为站点 i 的编号\n' +
      '  int find_next_station(int s, int t, std::vector<int> c);\n' +
      '      // 当前站编号 s、终点编号 t、当前站邻居编号升序列表 c；返回下一跳站点的编号\n\n' +
      '评测方式（两次运行）：第一次运行只调用 label 并保存编号方案；第二次重新运行（两次运行相互独立，\n' +
      '不能通过全局变量传递信息），用保存的编号对每个查询调用 find_next_station，返回值与评测机在树上\n' +
      '算出的正确下一跳编号比对。\n\n' +
      '判题口径（本 OJ）：编号互不相同且都在 [0,k] 内；每个查询必须返回正确下一跳。只判正确性（二值判定），\n' +
      '不按官方子任务的最大编号 m 计部分分，AC 明细会显示 m。测试数据 n≤30、k=100（官方原题 n≤1000）。\n\n' +
      '样例：n=5、k=10，边为 0-1、1-2、1-3、2-4。评测机可给出编号 [6,2,9,3,7]：\n' +
      '  查询 z=2→y=0：s=9、t=6、c=[2,7]，应返回 2（站点 1 的编号）；\n' +
      '  查询 z=1→y=3：s=2、t=3、c=[3,6,9]，应返回 3（站点 3 本身就是邻居）。\n\n' +
      '来源：洛谷 P6838 [IOI 2020] 网络站点（Stations），改编为本 OJ 两进程评测协议。',
    timeLimitMs: 1000,
    memoryLimitMb: 64,
    solution:
      '**思路**：编号必须把树的路径信息编码进去。入门方案（m ≤ 2n-1）：以 0 为根 DFS，用同一个计数器在进入 / 离开节点时各 +1 记入 tin / tout（取值 0..2n-1）；深度为偶数的站点编号取 tin，深度为奇数的取 tout（注意 tout 的奇偶性与深度相反，奇数深度取 tout 也是偶数——全部编号均为偶，不能靠 s 的奇偶判深度）。\n\n' +
      '**路由**：看邻居编号升序的端点与 s 的大小关系——邻居编号全大于 s 时当前站深度为偶，最后一个邻居必是父节点：若 t < s 转发父节点，否则转发「第一个编号 ≥ t 的邻居」（子树的全部进出计数器值恰为相邻子节点编号开区间，t 超过所有子节点编号时自然命中父节点）；邻居编号全小于 s 时深度为奇，第一个邻居是父节点：若 t > s 转发父节点，否则转发「编号 ≤ t 的非父邻居中最大的」，无则父节点。\n\n' +
      '更优的 m ≤ n-1 压缩构造（子树区间编号、节点取区间端点）见官方题解。',
    solution_visible: 1,
    is_published: 1,
    is_communication: 1,
    protocol: JSON.stringify({
      driver: 'stations',
      fn1: 'label',
      fn2: 'find_next_station',
    }),
  };
  // 测试数据（官方样例评测器格式：n k / n-1 条边 / q / q 行 z y；expectedOutput 弃用，
  // 判定由内置 grader 完成）。第 1 组为官方样例（k=10 与题面一致；n=5 时 2n-1=9≤10，
  // 简单标号方案可通过），其余组 k=100（n≤30 时 2n-1≤59≤100，同样放行入门方案）。
  const testcases = [
    // 官方样例
    { input: '5 10\n0 1\n1 2\n1 3\n2 4\n2\n2 0\n1 3\n', expectedOutput: '', isSample: 1 },
    // 链 0-1-2-3-4-5：相邻直达、隔多跳、反向、端点互达
    {
      input: '6 100\n0 1\n1 2\n2 3\n3 4\n4 5\n6\n0 1\n0 5\n5 0\n3 0\n2 4\n1 4\n',
      expectedOutput: '',
      isSample: 0,
    },
    // 星形（0 为中心连 1..7）：叶→叶必经中心、中心→叶、叶→中心
    {
      input: '8 100\n0 1\n0 2\n0 3\n0 4\n0 5\n0 6\n0 7\n8\n1 2\n3 7\n0 5\n6 0\n1 0\n0 3\n4 2\n7 5\n',
      expectedOutput: '',
      isSample: 0,
    },
    // 完全二叉树（15 节点，i 的左右子为 2i+1/2i+2）：跨子树、父子相邻、根→深叶、深叶→根
    {
      input: '15 100\n' +
        '0 1\n0 2\n1 3\n1 4\n2 5\n2 6\n3 7\n3 8\n4 9\n4 10\n5 11\n5 12\n6 13\n6 14\n' +
        '12\n7 8\n3 10\n0 14\n14 0\n1 3\n3 1\n5 6\n13 12\n9 1\n2 10\n14 4\n10 14\n',
      expectedOutput: '',
      isSample: 0,
    },
    // 随机树（30 节点，手工构造的固定树形）：长路径、多分支往返
    {
      input: '30 100\n' +
        '0 1\n0 2\n0 3\n0 4\n1 5\n1 6\n2 7\n2 8\n2 9\n3 10\n4 11\n4 12\n5 13\n6 14\n6 15\n' +
        '7 16\n8 17\n8 18\n9 19\n10 20\n10 21\n11 22\n12 23\n13 24\n15 25\n16 26\n16 27\n18 28\n21 29\n' +
        '20\n29 0\n0 29\n5 9\n14 24\n17 29\n28 26\n22 12\n25 19\n1 0\n0 3\n20 21\n13 5\n6 4\n12 29\n16 0\n11 20\n24 14\n10 6\n2 29\n23 7\n',
      expectedOutput: '',
      isSample: 0,
    },
  ];

  let problemId;
  const exists = db.prepare('SELECT id FROM problems WHERE title = ?').get(data.title);
  if (exists) {
    problemId = Number(exists.id);
    // 已存在：刷新题面与限制到最新定义（幂等）
    db.prepare(
      `UPDATE problems SET description = ?, time_limit_ms = ?, memory_limit_mb = ?, solution = ?,
              solution_visible = ?, is_published = ?, is_communication = ?, protocol = ?, updated_at = datetime('now')
       WHERE id = ?`
    ).run(
      data.description, data.timeLimitMs, data.memoryLimitMb, data.solution,
      data.solution_visible, data.is_published, data.is_communication, data.protocol, problemId
    );
  } else {
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
  // 测试数据整体替换（幂等，与 ensureProblem 一致）
  db.prepare('DELETE FROM testcases WHERE problem_id = ?').run(problemId);
  const insTc = db.prepare(
    'INSERT INTO testcases (problem_id, ordinal, input, expected_output, is_sample) VALUES (?, ?, ?, ?, ?)'
  );
  testcases.forEach((tc, i) => insTc.run(problemId, i + 1, tc.input, tc.expectedOutput, tc.isSample ? 1 : 0));
  return problemId;
}

ensureStationsProblem(adminId);

// 通信题示例：数组求和接力（two-phase 泛化协议：vector<int> 参数 + long long 返回 + long long 中间值）
// 演示非默认签名的类型菜单：fn1(vector<int>)→long long、fn2(long long,int)→long long（X 为第一参）
function ensureArraySumRelayProblem(adminId) {
  const data = {
    title: '数组求和接力',
    description:
      '【通信题·类型菜单】给定一个整数数组 a 与一个整数 k。\n' +
      '第一次运行：sum 计算 a 中所有元素之和（long long），作为中间值传给第二次运行。\n' +
      '第二次运行：plus 收到该和 x 与整数 k，返回 x + k。\n\n' +
      '你需要实现以下两个函数（不要实现 main，评测驱动会自动调用）：\n' +
      '  long long sum(std::vector<int> a);   // 返回 a 的元素和（long long）\n' +
      '  long long plus(long long x, int k);  // 返回 x + k\n\n' +
      '评测方式（两进程）：第一次运行调用 sum 得到 x 后程序退出；第二次重新运行，以 x 为输入调用 plus 得到最终结果，与标准输出比对判定。两次运行相互独立，不能通过全局变量传递信息。\n\n' +
      '输入（每行一个参数）：第 1 行 sum 的 vector<int>（空格分隔整数），第 2 行 plus 的 int k。\n' +
      '输出：plus 的返回值（long long）。',
    timeLimitMs: 1000,
    memoryLimitMb: 64,
    solution:
      '`sum` 用 long long 累加避免 int 溢出；`plus` 直接返回 x + k。本题意在演示通信题的泛化类型菜单（vector<int> 参数、long long 返回、long long 中间值，十进制字符串 ABI 保证 64 位精度）。\n\n' +
      '```cpp\n' +
      '#include <bits/stdc++.h>\n' +
      'long long sum(std::vector<int> a) { long long s = 0; for (int x : a) s += x; return s; }\n' +
      'long long plus(long long x, int k) { return x + k; }\n' +
      '```',
    solution_visible: 1,
    is_published: 1,
    is_communication: 1,
    protocol: JSON.stringify({
      driver: 'two-phase',
      fn1: { name: 'sum', params: ['vector<int>'], ret: 'long long' },
      fn2: { name: 'plus', params: ['long long', 'int'], xParam: 0, ret: 'long long' },
      xMax: 1000000000000000000, // 10^18，覆盖 long long 常见范围
      maxIntermediateBytes: 1024,
    }),
  };
  const testcases = [
    { input: '1 2 3\n10\n', expectedOutput: '16\n', isSample: 1 },
    { input: '1 2 3 4 5\n0\n', expectedOutput: '15\n', isSample: 1 },
    // 边界：5 个 10^9 之和 = 5×10^9，超出 32 位 int 上限（约 2.1×10^9），用 int 会溢出 WA；long long 正确
    { input: '1000000000 1000000000 1000000000 1000000000 1000000000\n0\n', expectedOutput: '5000000000\n' },
    { input: '7\n100\n', expectedOutput: '107\n' },
    { input: '1 2 3 4 5 6 7 8 9 10\n100\n', expectedOutput: '155\n' },
  ];

  let problemId;
  const exists = db.prepare('SELECT id FROM problems WHERE title = ?').get(data.title);
  if (exists) {
    problemId = Number(exists.id);
    db.prepare(
      `UPDATE problems SET description = ?, time_limit_ms = ?, memory_limit_mb = ?, solution = ?,
              solution_visible = ?, is_published = ?, is_communication = ?, protocol = ?, updated_at = datetime('now')
       WHERE id = ?`
    ).run(
      data.description, data.timeLimitMs, data.memoryLimitMb, data.solution,
      data.solution_visible, data.is_published, data.is_communication, data.protocol, problemId
    );
  } else {
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
  db.prepare('DELETE FROM testcases WHERE problem_id = ?').run(problemId);
  const insTc = db.prepare(
    'INSERT INTO testcases (problem_id, ordinal, input, expected_output, is_sample) VALUES (?, ?, ?, ?, ?)'
  );
  testcases.forEach((tc, i) => insTc.run(problemId, i + 1, tc.input, tc.expectedOutput, tc.isSample ? 1 : 0));
  return problemId;
}

ensureArraySumRelayProblem(adminId);

// 通信题示例：B3790 [信息与未来 2023] 文本压缩（改编：原题 COMPRESS/DECOMPRESS 两次运行 → 两个函数）
// two-phase 泛化协议：compress(string)→string、decompress(string)→string（X=压缩串为第二参，xParam=0）
function ensureCompressProblem(adminId) {
  const data = {
    title: 'B3790 文本压缩',
    description:
      '【通信题·改编】你需要设计一个英文文本的无损压缩与解压缩算法。\n' +
      '第一个函数负责压缩，第二个函数负责解压：\n' +
      '  std::string compress(std::string s);   // 输入仅含小写字母的字符串，输出压缩后的字符串（只允许大小写字母和数字）\n' +
      '  std::string decompress(std::string x); // 输入压缩后的字符串，输出还原的小写字母字符串\n\n' +
      '评测方式（两进程）：第一次运行调用 compress 得到压缩串 x 后程序退出；第二次重新运行，以 x 为输入调用 decompress 得到还原结果，与原字符串比对判定。两次运行相互独立，不能通过全局变量传递信息。\n\n' +
      '判定口径（本 OJ）：只判「解压能正确还原原文」（二值判定），不按压缩率给部分分；压缩率写进提示供你自行评估（原题 75% 满分 / 80% 半分）。\n\n' +
      '样例：compress("aaaaaaaabbbbbbbbbb") 可返回 "a8b10"，decompress("a8b10") 应还原为 "aaaaaaaabbbbbbbbbb"。\n\n' +
      '来源：B3790 [信息与未来 2023] 文本压缩（原题暂无 SPJ；改编为本 OJ 两进程评测协议）。',
    timeLimitMs: 2000,
    memoryLimitMb: 64,
    solution:
      '最简单的无损压缩是**游程编码（RLE）**：把连续相同字符压缩为「字符+个数」。\n\n' +
      '```cpp\n' +
      '#include <bits/stdc++.h>\n' +
      'std::string compress(std::string s) { std::string out; for (int i = 0; i < (int)s.size(); ) { int j = i; while (j < (int)s.size() && s[j] == s[i]) j++; out += s[i]; out += std::to_string(j - i); i = j; } return out; }\n' +
      'std::string decompress(std::string t) { std::string out; for (int i = 0; i < (int)t.size(); ) { char c = t[i++]; int n = 0; while (i < (int)t.size() && isdigit(t[i])) n = n * 10 + (t[i++] - \'0\'); out += std::string(n, c); } return out; }\n' +
      '```\n\n' +
      '注意：RLE 对重复串压缩率高，对无重复串会变长；本题只判还原正确，不判压缩率，可在此基础上尝试更优的压缩方案。',
    solution_visible: 1,
    is_published: 1,
    is_communication: 1,
    protocol: JSON.stringify({
      driver: 'two-phase',
      fn1: { name: 'compress', params: ['string'], ret: 'string' },
      fn2: { name: 'decompress', params: ['string'], xParam: 0, ret: 'string' },
      maxIntermediateBytes: 100000,
    }),
  };
  // 测试数据：input 一行 = 待压缩原文（fn1 的参数），expectedOutput = 同一字符串（解压还原目标）
  const testcases = [
    { input: 'aaaaaaaabbbbbbbbbb\n', expectedOutput: 'aaaaaaaabbbbbbbbbb\n', isSample: 1 },
    { input: 'hellohellohello\n', expectedOutput: 'hellohellohello\n', isSample: 1 },
    { input: 'mississippi\n', expectedOutput: 'mississippi\n' },
    { input: 'thequickbrownfoxjumpsoverthelazydogthequickbrownfoxjumpsoverthelazydog\n', expectedOutput: 'thequickbrownfoxjumpsoverthelazydogthequickbrownfoxjumpsoverthelazydog\n' },
    { input: 'aaabbbcccdddeeefffggghhhiiijjjkkklllmmmnnnooopppqqqrrrssstttuuuvvvwwwxxxyyyzzz\n', expectedOutput: 'aaabbbcccdddeeefffggghhhiiijjjkkklllmmmnnnooopppqqqrrrssstttuuuvvvwwwxxxyyyzzz\n' },
  ];

  let problemId;
  const exists = db.prepare('SELECT id FROM problems WHERE title = ?').get(data.title);
  if (exists) {
    problemId = Number(exists.id);
    db.prepare(
      `UPDATE problems SET description = ?, time_limit_ms = ?, memory_limit_mb = ?, solution = ?,
              solution_visible = ?, is_published = ?, is_communication = ?, protocol = ?, updated_at = datetime('now')
       WHERE id = ?`
    ).run(
      data.description, data.timeLimitMs, data.memoryLimitMb, data.solution,
      data.solution_visible, data.is_published, data.is_communication, data.protocol, problemId
    );
  } else {
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
  db.prepare('DELETE FROM testcases WHERE problem_id = ?').run(problemId);
  const insTc = db.prepare(
    'INSERT INTO testcases (problem_id, ordinal, input, expected_output, is_sample) VALUES (?, ?, ?, ?, ?)'
  );
  testcases.forEach((tc, i) => insTc.run(problemId, i + 1, tc.input, tc.expectedOutput, tc.isSample ? 1 : 0));
  return problemId;
}

ensureCompressProblem(adminId);

// 通信题示例：P9165 [INOH Round 1] 意外（改编：原题 50% 元素噪声 + 多次调用 + 按编码长度评分
// → 本 OJ 两进程协议：噪声率 20%、固定 seed 可复现、二值判定）
// 使用 two-phase 泛化 + mutate（noise-num 中间值变换）：encode 的输出数字串在传给 decode 前，
// 每个数字按 ratio 概率被替换成 [min,max] 内随机数（固定 seed 驱动 LCG，评测可复现）。
function ensureNoiseProblem(adminId) {
  const data = {
    title: 'P9165 意外',
    description:
      '【通信题·改编】通信信道里会发生意外：编码串的每个数字都有一定概率被损坏。\n' +
      '第一个函数负责编码，第二个函数负责解码：\n' +
      '  std::string encode(std::vector<int> v); // 输入原数组（元素 ∈ [0, 998244353)），输出编码串（空格分隔的数字）\n' +
      '  std::string decode(std::string x);      // 输入被噪声损坏后的编码串，输出还原数组（空格分隔的整数）\n\n' +
      '评测方式（两进程）：第一次运行调用 encode 得到编码串 x 后程序退出；评测机按固定随机种子把 x 中每个数字以 20% 概率替换成 [0, 998244352] 内的随机数，得到损坏串 x\'；第二次重新运行，以 x\' 为输入调用 decode 得到还原结果，与原数组比对判定。两次运行相互独立，不能通过全局变量传递信息。\n\n' +
      '判定口径（本 OJ）：还原数组与原数组完全一致才 AC（二值判定）；噪声按固定种子注入，评测可复现。不按原题的编码长度给部分分——编码越冗余越抗噪，但你可以自行在冗余与简洁之间权衡。\n\n' +
      '来源：P9165 「INOH」Round 1 - 意外（原题 50% 元素噪声、多次调用、按最大编码长度评分；改编为本 OJ 两进程评测协议，噪声率 20%、单次调用、二值判定）。',
    timeLimitMs: 2000,
    memoryLimitMb: 64,
    solution:
      '最简单的抗噪编码：每个原数字重复 5 份，解码时 5 份多数表决（噪声率 20% 下，5 份中 3 份及以上未损坏的概率约 94%，短数组几乎必然还原）。\n\n' +
      '```cpp\n' +
      '#include <bits/stdc++.h>\n' +
      'std::string encode(std::vector<int> v) { std::string s; for (int i = 0; i < (int)v.size(); i++) { if (i) s += \' \'; for (int r = 0; r < 5; r++) { if (r) s += \' \'; s += std::to_string(v[i]); } } return s; }\n' +
      'std::string decode(std::string x) { std::istringstream in(x); std::vector<int> nums; int t; while (in >> t) nums.push_back(t); std::string out; for (int i = 0; i + 4 < (int)nums.size(); i += 5) { std::map<int,int> cnt; for (int k = 0; k < 5; k++) cnt[nums[i+k]]++; int best = nums[i], bc = 0; for (auto &p : cnt) if (p.second > bc) { bc = p.second; best = p.first; } if (out.size()) out += \' \'; out += std::to_string(best); } return out; }\n' +
      '```\n\n' +
      '更优的方案可用校验和定位被损坏的份、或用更紧凑的冗余编码。',
    solution_visible: 1,
    is_published: 1,
    is_communication: 1,
    protocol: JSON.stringify({
      driver: 'two-phase',
      fn1: { name: 'encode', params: ['vector<int>'], ret: 'string' },
      fn2: { name: 'decode', params: ['string'], xParam: 0, ret: 'string' },
      mutate: { type: 'noise-num', ratio: 0.2, seed: 20260827, min: 0, max: 998244352 },
      maxIntermediateBytes: 100000,
    }),
  };
  // 测试数据：input 一行 = 原数组（空格分隔），expectedOutput = 还原目标（同一数组的空格分隔表示）
  const testcases = [
    { input: '1 2 3\n', expectedOutput: '1 2 3\n', isSample: 1 },
    { input: '7 42 99\n', expectedOutput: '7 42 99\n', isSample: 1 },
    { input: '1 2 3 4 5\n', expectedOutput: '1 2 3 4 5\n' },
    { input: '10 20 30 40\n', expectedOutput: '10 20 30 40\n' },
    { input: '5 1 9 2 8\n', expectedOutput: '5 1 9 2 8\n' },
  ];

  let problemId;
  const exists = db.prepare('SELECT id FROM problems WHERE title = ?').get(data.title);
  if (exists) {
    problemId = Number(exists.id);
    db.prepare(
      `UPDATE problems SET description = ?, time_limit_ms = ?, memory_limit_mb = ?, solution = ?,
              solution_visible = ?, is_published = ?, is_communication = ?, protocol = ?, updated_at = datetime('now')
       WHERE id = ?`
    ).run(
      data.description, data.timeLimitMs, data.memoryLimitMb, data.solution,
      data.solution_visible, data.is_published, data.is_communication, data.protocol, problemId
    );
  } else {
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
  db.prepare('DELETE FROM testcases WHERE problem_id = ?').run(problemId);
  const insTc = db.prepare(
    'INSERT INTO testcases (problem_id, ordinal, input, expected_output, is_sample) VALUES (?, ?, ?, ?, ?)'
  );
  testcases.forEach((tc, i) => insTc.run(problemId, i + 1, tc.input, tc.expectedOutput, tc.isSample ? 1 : 0));
  return problemId;
}

ensureNoiseProblem(adminId);

// 通信题示例：P10539 魔术表演（改编：原题多次询问、删至多 B 条边、最小化 B
// → 本 OJ 单组、恰好删 1 条边、固定 seed 可复现、二值判定）
// 使用 two-phase + mutate（delete-edges 删边信道）：alice 输出边集字符串，grader 按固定
// seed 从边集中删恰好 1 条边后传给 bob，bob 猜原排列。
function ensureMagicProblem(adminId) {
  const data = {
    title: 'P10539 魔术表演',
    description:
      '【通信题·改编】一场魔术：Alice 把秘密编进一幅图里，Catherine 从中删掉 1 条边，Bob 要凭剩下的图猜出秘密。\n' +
      '第一个函数负责编码，第二个函数负责解码：\n' +
      '  std::string alice(std::vector<int> p); // 输入 1..N 的排列 p（N ≤ 30），输出编码串\n' +
      '  std::string bob(std::string s);        // 输入删边后的编码串，输出猜出的排列（空格分隔）\n\n' +
      '编码串格式（alice 输出约定）：前 3 个数是元数据 N i j（N = 点数；i = 元素 1 在 p 中的位置；j = 元素 N 在 p 中的位置，均从 1 数起），随后是 N-1 条边的边集（空格分隔：u1 v1 u2 v2 ...，端点 ∈ [1,N]）。\n\n' +
      '评测方式（两进程）：第一次运行调用 alice 得到编码串后程序退出；评测机按固定随机种子从边集中恰好删去 1 条边（元数据 N i j 不参与删边、原样保留）；第二次重新运行，以删边后的编码串为输入调用 bob 得到猜出的排列，与原排列比对判定。两次运行相互独立，不能通过全局变量传递信息。\n\n' +
      '判定口径（本 OJ）：猜出的排列与原排列完全一致才 AC（二值判定）；删边按固定种子注入，评测可复现。\n\n' +
      '样例：p = [1,2,3]，alice 可输出 "3 1 3 1 2 2 3"（元数据 3 1 3 + 链 1-2-3 的两条边）；若评测机删去边 (1,2)，bob 收到 "3 1 3 2 3"，据此猜 [1,2,3]。\n\n' +
      '来源：P10539 魔术表演（原题多次询问、删至多 B 条边并最小化 B；改编为本 OJ 两进程评测协议：单组、恰好删 1 条边、二值判定）。',
    timeLimitMs: 2000,
    memoryLimitMb: 64,
    solution:
      '**双锚链方案**：把 1 固定为链头、N 固定为链尾，中间按 p 去掉 1 和 N 后的顺序串联；元数据 i、j 记录 1 和 N 在 p 中的位置。删任意 1 条边后：含 1 的段必是前缀、含 N 的段必是后缀（各自从锚点出发遍历路径即可确定方向），拼出中间顺序，再按 i、j 把 1 和 N 插回原位即得原排列。参考代码：\n\n' +
      '```cpp\n' +
      '#include <bits/stdc++.h>\n' +
      'std::string alice(std::vector<int> p) { int n = (int)p.size(), pos1 = 0, posN = 0; for (int i = 0; i < n; i++) { if (p[i] == 1) pos1 = i + 1; if (p[i] == n) posN = i + 1; } std::vector<int> mid; for (int x : p) if (x != 1 && x != n) mid.push_back(x); std::vector<int> v; v.push_back(1); for (int x : mid) v.push_back(x); v.push_back(n); std::string s = std::to_string(n) + " " + std::to_string(pos1) + " " + std::to_string(posN); for (int i = 0; i + 1 < (int)v.size(); i++) s += " " + std::to_string(v[i]) + " " + std::to_string(v[i + 1]); return s; }\n' +
      'std::string bob(std::string s) { std::istringstream in(s); std::vector<int> nums; int t; while (in >> t) nums.push_back(t); int n = nums[0], pos1 = nums[1], posN = nums[2]; std::map<int, std::vector<int>> g; for (int i = 3; i + 1 < (int)nums.size(); i += 2) { g[nums[i]].push_back(nums[i + 1]); g[nums[i + 1]].push_back(nums[i]); } std::vector<int> pre, suf; { int cur = 1, prev = -1; while (true) { pre.push_back(cur); int next = -1; for (int w : g[cur]) if (w != prev) { next = w; break; } if (next == -1) break; prev = cur; cur = next; } } { int cur = n, prev = -1; while (true) { suf.push_back(cur); int next = -1; for (int w : g[cur]) if (w != prev) { next = w; break; } if (next == -1) break; prev = cur; cur = next; } } std::reverse(suf.begin(), suf.end()); std::vector<int> mid; for (int x : pre) if (x != 1) mid.push_back(x); for (int x : suf) if (x != n) mid.push_back(x); std::vector<int> p(n); int k = 0; for (int pos = 1; pos <= n; pos++) { if (pos == pos1) p[pos - 1] = 1; else if (pos == posN) p[pos - 1] = n; else p[pos - 1] = mid[k++]; } std::string out; for (int i = 0; i < n; i++) { if (i) out += \' \'; out += std::to_string(p[i]); } return out; }\n' +
      '```\n\n' +
      '更优方案：原题要求最小化 B（删任意多条边仍可恢复），可用「环 + 度数标记」等构造，见官方题解。',
    solution_visible: 1,
    is_published: 1,
    is_communication: 1,
    protocol: JSON.stringify({
      driver: 'two-phase',
      fn1: { name: 'alice', params: ['vector<int>'], ret: 'string' },
      fn2: { name: 'bob', params: ['string'], xParam: 0, ret: 'string' },
      mutate: { type: 'delete-edges', delete: 1, seed: 20260827, meta: 3 },
      maxIntermediateBytes: 100000,
    }),
  };
  // 测试数据：input 一行 = 原排列（空格分隔），expectedOutput = 同一排列（猜中目标）
  const testcases = [
    { input: '1 2 3\n', expectedOutput: '1 2 3\n', isSample: 1 },
    { input: '3 1 2\n', expectedOutput: '3 1 2\n', isSample: 1 },
    { input: '1 3 2\n', expectedOutput: '1 3 2\n' },
    { input: '5 3 1 4 2\n', expectedOutput: '5 3 1 4 2\n' },
    { input: '1 2 3 4 5\n', expectedOutput: '1 2 3 4 5\n' },
    { input: '30 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24 25 26 27 28 29\n', expectedOutput: '30 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24 25 26 27 28 29\n' },
  ];

  let problemId;
  const exists = db.prepare('SELECT id FROM problems WHERE title = ?').get(data.title);
  if (exists) {
    problemId = Number(exists.id);
    db.prepare(
      `UPDATE problems SET description = ?, time_limit_ms = ?, memory_limit_mb = ?, solution = ?,
              solution_visible = ?, is_published = ?, is_communication = ?, protocol = ?, updated_at = datetime('now')
       WHERE id = ?`
    ).run(
      data.description, data.timeLimitMs, data.memoryLimitMb, data.solution,
      data.solution_visible, data.is_published, data.is_communication, data.protocol, problemId
    );
  } else {
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
  db.prepare('DELETE FROM testcases WHERE problem_id = ?').run(problemId);
  const insTc = db.prepare(
    'INSERT INTO testcases (problem_id, ordinal, input, expected_output, is_sample) VALUES (?, ?, ?, ?, ?)'
  );
  testcases.forEach((tc, i) => insTc.run(problemId, i + 1, tc.input, tc.expectedOutput, tc.isSample ? 1 : 0));
  return problemId;
}

ensureMagicProblem(adminId);

// ---------- 比赛示例（幂等，按标题匹配）----------
// 数据库时间格式（UTC）：YYYY-MM-DD HH:MM:SS
function dbTime(offsetMs) {
  return new Date(Date.now() + offsetMs).toISOString().slice(0, 19).replace('T', ' ');
}

function ensureContest(adminId, data) {
  const exists = db.prepare('SELECT id FROM contests WHERE title = ?').get(data.title);
  let contestId;
  if (exists) {
    contestId = Number(exists.id);
    db.prepare(
      `UPDATE contests SET description = ?, start_time = ?, end_time = ?, is_public = ?, freeze_time = ? WHERE id = ?`
    ).run(data.description, data.start_time, data.end_time, data.is_public, data.freeze_time ?? null, contestId);
  } else {
    const info = db
      .prepare(
        'INSERT INTO contests (title, description, start_time, end_time, is_public, freeze_time, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)'
      )
      .run(data.title, data.description, data.start_time, data.end_time, data.is_public, data.freeze_time ?? null, adminId);
    contestId = Number(info.lastInsertRowid);
  }
  // 赛题整体替换（幂等）
  db.prepare('DELETE FROM contest_problems WHERE contest_id = ?').run(contestId);
  const ins = db.prepare('INSERT INTO contest_problems (contest_id, problem_id, ordinal) VALUES (?, ?, ?)');
  data.problemTitles.forEach((title, i) => {
    const p = db.prepare('SELECT id FROM problems WHERE title = ?').get(title);
    if (p) ins.run(contestId, Number(p.id), i + 1);
  });
  return contestId;
}

const abTitle = 'A+B Problem';
const commTitle = 'P12509 通信题';

ensureContest(adminId, {
  title: '新手练习赛',
  description: '面向新手的入门练习赛，涵盖基础输入输出与 64 位整数溢出陷阱。',
  start_time: dbTime(-24 * 3600 * 1000),          // 昨天开始
  end_time: dbTime(7 * 24 * 3600 * 1000),          // 7 天后结束
  is_public: 1,
  problemTitles: [abTitle, commTitle],
});

ensureContest(adminId, {
  title: '历史周赛 #1',
  description: '已结束的周赛，供回顾赛题与难度。',
  start_time: dbTime(-10 * 24 * 3600 * 1000),
  end_time: dbTime(-3 * 24 * 3600 * 1000),
  freeze_time: dbTime(-10 * 24 * 3600 * 1000 + 60 * 60 * 1000), // 开赛后 60 分钟封榜，封榜后提交冻结、滚榜逐格揭晓
  is_public: 1,
  problemTitles: [abTitle, commTitle, 'P6838 网络站点', '数组求和接力'],
});

// ---------- 滚榜演示数据（历史周赛 #1，幂等：整体重建该比赛提交）----------
// 已结束比赛不可再提交，此处直接落库 8 名选手 40 条已完成提交（状态 done、时间落在比赛窗口内，
// 4 道赛题、封榜前后各有一批提交；封榜后提交冻结，滚榜逐格揭晓并引起排名变化）。
// 虚拟选手（alice/bob/carol/dave/eve/frank/grace）口令随机不可知、无法登录，仅用于榜单与赛后滚榜演示。
function ensureContestUser(username) {
  const exists = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (exists) return Number(exists.id);
  const salt = crypto.randomBytes(16).toString('hex');
  const info = db
    .prepare('INSERT INTO users (username, password_hash, salt, role) VALUES (?, ?, ?, ?)')
    .run(
      username,
      hashPassword('seed-' + username + '-' + crypto.randomBytes(8).toString('hex'), salt),
      salt,
      'member'
    );
  return Number(info.lastInsertRowid);
}

// 比赛开始时间 + N 分钟 → 数据库 UTC 时间字符串
function dbShift(base, minutes) {
  return new Date(Date.parse(base.replace(' ', 'T') + 'Z') + minutes * 60000)
    .toISOString()
    .slice(0, 19)
    .replace('T', ' ');
}

const AC_DETAILS = JSON.stringify([1, 2, 3, 4].map((o) => ({ ordinal: o, ok: true })));
const WA_DETAILS = JSON.stringify([
  { ordinal: 1, ok: false, input: '1 2\n', expectedOutput: '3\n', actualOutput: '-1\n' },
]);
const CE_DETAILS = "main.cpp: In function 'int main()':\nmain.cpp:1:17: error: expected ';' before '}' token";
const AC_CODE = '#include <iostream>\nint main(){long long a,b;std::cin>>a>>b;std::cout<<a+b;}';
const WA_CODE = '#include <iostream>\nint main(){long long a,b;std::cin>>a>>b;std::cout<<a-b;}';
const CE_CODE = '#include <iostream>\nint main(){long long a,b;std::cin>>a>>b;std::cout<<a+b}'; // 少一个分号

const revealContest = db.prepare('SELECT id, start_time FROM contests WHERE title = ?').get('历史周赛 #1');
if (revealContest) {
  const revealContestId = Number(revealContest.id);
  // 赛题标题 → id（历史周赛 #1 的 4 道题）
  const problemIdOf = new Map();
  for (const title of [abTitle, commTitle, 'P6838 网络站点', '数组求和接力']) {
    const p = db.prepare('SELECT id FROM problems WHERE title = ?').get(title);
    if (p) problemIdOf.set(title, Number(p.id));
  }
  // 幂等：该比赛提交整体重建（比赛已结束、真实用户无法提交，重建安全）
  db.prepare('DELETE FROM submissions WHERE contest_id = ?').run(revealContestId);
  const insRevealSub = db.prepare(
    `INSERT INTO submissions (problem_id, user_id, language, source_code, is_public, status, verdict,
                              details, time_ms, memory_kb, created_at, judged_at, contest_id)
     VALUES (?, ?, 'cpp', ?, 1, 'done', ?, ?, ?, ?, ?, ?, ?)`
  );
  // [选手, 赛题标题, 判定, 开赛后第几分钟]；数组顺序 = 提交 id 升序 = 滚榜揭晓顺序
  const revealScript = [
    ['bob',   abTitle,    'WA',   8],
    ['alice', abTitle,    'AC',  10], // 首杀 A
    ['dave',  abTitle,    'WA',  12],
    ['carol', abTitle,    'AC',  15],
    ['eve',   abTitle,    'WA',  18],
    ['bob',   abTitle,    'AC',  20],
    ['frank', abTitle,    'WA',  22],
    ['alice', commTitle,  'AC',  25], // 首杀 B
    ['dave',  abTitle,    'WA',  25],
    ['grace', abTitle,    'WA',  28],
    ['demo',  abTitle,    'WA',  30],
    ['bob',   commTitle,  'WA',  35],
    ['alice', 'P6838 网络站点', 'AC',  40], // 首杀 C
    ['carol', commTitle,  'WA',  42],
    ['eve',   commTitle,  'WA',  45],
    ['dave',  commTitle,  'AC',  48],
    ['frank', commTitle,  'WA',  50],
    ['dave',  '数组求和接力', 'AC',  50], // 首杀 D
    ['grace', commTitle,  'WA',  52],
    ['eve',   'P6838 网络站点', 'WA',  54],
    ['bob',   'P6838 网络站点', 'WA',  55],
    ['grace', '数组求和接力', 'WA',  56],
    ['carol', 'P6838 网络站点', 'WA',  58],
    // ---- 封榜（开赛后 60 分钟）之后的冻结提交，滚榜逐格揭晓 ----
    ['bob',   commTitle,  'AC',  62],
    ['demo',  commTitle,  'WA',  63],
    ['eve',   abTitle,    'AC',  65],
    ['bob',   'P6838 网络站点', 'AC',  66],
    ['carol', commTitle,  'AC',  68],
    ['demo',  'P6838 网络站点', 'WA',  69],
    ['frank', abTitle,    'AC',  70],
    ['eve',   commTitle,  'AC',  72],
    ['eve',   'P6838 网络站点', 'AC',  74],
    ['grace', abTitle,    'AC',  75],
    ['demo',  '数组求和接力', 'WA',  77],
    ['frank', commTitle,  'AC',  78],
    ['carol', '数组求和接力', 'AC',  80],
    ['grace', commTitle,  'AC',  82],
    ['eve',   '数组求和接力', 'WA',  85],
    ['frank', '数组求和接力', 'WA',  88],
    ['grace', '数组求和接力', 'WA',  90],
  ];
  for (const [name, ptitle, verdict, minute] of revealScript) {
    const pid = problemIdOf.get(ptitle);
    if (!pid) continue;
    const code = verdict === 'CE' ? CE_CODE : verdict === 'AC' ? AC_CODE : WA_CODE;
    insRevealSub.run(
      pid, ensureContestUser(name), code, verdict,
      verdict === 'CE' ? CE_DETAILS : verdict === 'AC' ? AC_DETAILS : WA_DETAILS,
      verdict === 'CE' ? 5231 : 28, verdict === 'CE' ? null : 65536,
      dbShift(revealContest.start_time, minute), dbShift(revealContest.start_time, minute + 1),
      revealContestId
    );
  }
}

console.log('演示数据已就绪：');
console.log('  会员账号：demo / demo123');
console.log('  管理员账号：admin / admin123');
console.log('  样例题目：A+B Problem（4 组测试数据，含 int 溢出边界）、P12509 通信题（两进程函数式）、P6838 网络站点（stations：数组参数 + 内置 grader）、数组求和接力（two-phase 类型菜单：vector<int> + long long）、B3790 文本压缩（two-phase：compress/decompress）、P9165 意外（two-phase + mutate 噪声信道：encode/decode）、P10539 魔术表演（two-phase + mutate 删边信道：alice/bob）');
console.log('  样例比赛：新手练习赛（进行中）、历史周赛 #1（已结束，含滚榜演示数据：8 名选手 40 条提交、4 道赛题）');
