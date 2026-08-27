// realdata-check.js —— 真实比赛提交记录回归检查（第 8 天交付收口）
// 用途：用真实 data/weboj.db（只读：不 seed、不写库、只 GET + SELECT）验证 OJ 在真实比赛
//       提交记录下的榜单计算、用户统计、提交列表/详情与数据库一致。
// 用法：node scripts/realdata-check.js（npm run realdata）
// 说明：只读检查，不产生新提交、不污染真实数据；并发压测另见 npm run stress（内存库）。

const http = require('http');
const db = require('../server/db');   // 默认 data/weboj.db（真实库）
const app = require('../server/app');
const ws = require('../server/ws');

const server = http.createServer(app);
ws.init(server);

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); }
  else { fail += 1; console.error(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
}

function httpGet(path) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: server.address().port, path, method: 'GET' }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch (e) {}
        resolve({ status: res.statusCode, json });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function main() {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));

  // ===== 0. 数据概况 =====
  const total = Number(db.prepare('SELECT COUNT(*) c FROM submissions').get().c);
  const doneCount = Number(db.prepare("SELECT COUNT(*) c FROM submissions WHERE status = 'done'").get().c);
  check('真实库有提交记录', total > 0, `总数=${total}`);
  check('全部提交已完成（done）', doneCount === total, `done=${doneCount}/${total}`);

  // ===== 1. 榜单（历史周赛 #1，按标题取 id）=====
  const contest = db.prepare("SELECT id, title FROM contests WHERE title = '历史周赛 #1'").get();
  check('存在历史周赛 #1', !!contest);
  if (contest) {
    const r = await httpGet(`/api/contests/${contest.id}/scoreboard`);
    check('榜单接口可访问', r.status === 200);
    const sb = r.json || {};
    const rows = sb.rows || [];
    const subs = sb.submissions || [];

    // 排序自洽：AC 数降序、罚时升序
    let sortedOk = true;
    for (let i = 1; i < rows.length; i++) {
      const a = rows[i - 1];
      const b = rows[i];
      if (b.solved > a.solved || (b.solved === a.solved && b.penalty < a.penalty)) { sortedOk = false; break; }
    }
    const rankOk = rows.every((row, i) => row.rank === i + 1);
    check('榜单按 AC 数降序、罚时升序排序', sortedOk);
    check('榜单 rank 连续（1..n）', rankOk);

    // 终榜罚时核对（历史周赛 #1 滚榜演示数据，第 6/7 天报告终榜口径：AC 数/罚时）
    const expect = { alice: [3, 75], carol: [3, 183], bob: [3, 208], eve: [3, 271], dave: [2, 98], frank: [2, 188], grace: [2, 197], demo: [0, 0] };
    for (const [name, [solved, penalty]] of Object.entries(expect)) {
      const row = rows.find((x) => x.username === name);
      check(`终榜 ${name}：solved=${solved} penalty=${penalty}`,
        row && row.solved === solved && row.penalty === penalty,
        row ? `实际 ${row.solved}/${row.penalty}` : '未找到该用户');
    }

    // 滚榜序列：条数 = 比赛提交数，且按提交先后（id 升序）
    const subCount = Number(db.prepare('SELECT COUNT(*) c FROM submissions WHERE contest_id = ?').get(contest.id).c);
    check('滚榜序列条数 = 比赛提交数', subs.length === subCount, `${subs.length}/${subCount}`);
    let ascOk = true;
    for (let i = 1; i < subs.length; i++) if (!(subs[i].id > subs[i - 1].id)) { ascOk = false; break; }
    check('滚榜序列按提交先后（id 升序）', ascOk);
  }

  // ===== 2. 用户统计（demo，提交数最多）=====
  const demo = db.prepare("SELECT id FROM users WHERE username = 'demo'").get();
  if (demo) {
    const totalSubs = Number(db.prepare('SELECT COUNT(*) c FROM submissions WHERE user_id = ?').get(demo.id).c);
    const solvedCount = Number(db.prepare("SELECT COUNT(DISTINCT problem_id) c FROM submissions WHERE user_id = ? AND verdict = 'AC'").get(demo.id).c);
    const attemptedCount = Number(db.prepare(
      `SELECT COUNT(*) c FROM (
         SELECT DISTINCT problem_id FROM submissions WHERE user_id = ?
         EXCEPT
         SELECT DISTINCT problem_id FROM submissions WHERE user_id = ? AND verdict = 'AC'
       )`
    ).get(demo.id, demo.id).c);
    const r = await httpGet('/api/users/demo');
    check('用户主页可访问', r.status === 200);
    if (r.json && r.json.stats) {
      check('demo 提交总数一致', r.json.stats.totalSubmissions === totalSubs, `${r.json.stats.totalSubmissions}/${totalSubs}`);
      check('demo 已解决题数一致', r.json.stats.solvedCount === solvedCount, `${r.json.stats.solvedCount}/${solvedCount}`);
      check('demo 尝试未解题数一致', r.json.stats.attemptedCount === attemptedCount, `${r.json.stats.attemptedCount}/${attemptedCount}`);
      check('demo 已解决列表条数 = solvedCount', (r.json.solvedProblems || []).length === solvedCount);
      check('demo 尝试列表条数 = attemptedCount', (r.json.attemptedProblems || []).length === attemptedCount);
      check('demo 热力图非空', Array.isArray(r.json.heatmap) && r.json.heatmap.length > 0);
    }
  }

  // ===== 3. 提交列表与过滤 =====
  {
    const r = await httpGet('/api/submissions');
    check('提交列表返回全部（≤200）', r.status === 200 && Array.isArray(r.json) && r.json.length === total, `${r.json && r.json.length}/${total}`);
    let descOk = true;
    for (let i = 1; i < (r.json || []).length; i++) if (!(r.json[i].id < r.json[i - 1].id)) { descOk = false; break; }
    check('提交列表按 id 倒序', descOk);

    if (contest) {
      const cSubs = Number(db.prepare('SELECT COUNT(*) c FROM submissions WHERE contest_id = ?').get(contest.id).c);
      const rc = await httpGet(`/api/submissions?contestId=${contest.id}`);
      check('按比赛过滤提交列表', rc.status === 200 && rc.json.length === cSubs && rc.json.every((s) => s.contestId === contest.id), `${rc.json && rc.json.length}/${cSubs}`);
    }

    const pid = db.prepare('SELECT id FROM problems LIMIT 1').get();
    if (pid) {
      const pSubs = Number(db.prepare('SELECT COUNT(*) c FROM submissions WHERE problem_id = ?').get(pid.id).c);
      const rp = await httpGet(`/api/submissions?problemId=${pid.id}`);
      check('按题目过滤提交列表', rp.status === 200 && rp.json.length === pSubs && rp.json.every((s) => s.problemId === pid.id), `${rp.json && rp.json.length}/${pSubs}`);
    }
  }

  // ===== 4. 提交详情抽样 =====
  {
    const sample = db.prepare('SELECT id, verdict FROM submissions ORDER BY id LIMIT 1').get();
    if (sample) {
      const r = await httpGet(`/api/submissions/${sample.id}`);
      check('提交详情可访问且 verdict 一致', r.status === 200 && r.json.verdict === sample.verdict, `期望 ${sample.verdict}，实际 ${r.json && r.json.verdict}`);
    }
  }

  server.close();
  console.log(`\n结果：${pass} 通过，${fail} 失败`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('真实数据回归检查运行失败：', e);
  process.exit(1);
});
