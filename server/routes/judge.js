// judge-api 模块：供评测机调用的任务拉取（GET）与结果回传（POST）
// 鉴权：请求头 x-judge-key（启动时自动生成，存 data/.judge-key）
// 任务队列：按提交先后（id 升序）FIFO；拉取即置 judging，事务保证不重复发放
// 自助评测通道（纯前端评测机）：self/claim + self/results，JWT 鉴权、仅限本人提交
const crypto = require('crypto');
const express = require('express');
const db = require('../db');
const config = require('../config');
const ws = require('../ws');
const { requireRole } = require('../middleware/auth');

const router = express.Router();

const VERDICTS = ['AC', 'WA', 'TLE', 'MLE', 'RE', 'CE'];

// protocol 在库中为 JSON 字符串（通信题协议配置），安全解析为对象
function safeParse(s) {
  try { return typeof s === 'string' ? JSON.parse(s) : (s || null); }
  catch (e) { return null; }
}

// 结果写回：judging → done（幂等：已 done 的重复回传返回当前状态）
function finishSubmission(submissionId, verdict, details, timeMs, memoryKb) {
  const sub = db.prepare('SELECT * FROM submissions WHERE id = ?').get(submissionId);
  if (!sub) return { status: 404, body: { error: '提交不存在' } };
  if (sub.status === 'done') {
    return { status: 200, body: { ok: true, submissionId, status: sub.status, verdict: sub.verdict } };
  }
  if (sub.status !== 'judging') {
    return { status: 409, body: { error: '该提交未被拉取（未进入评测中状态）' } };
  }
  db.prepare(
    `UPDATE submissions SET status = 'done', verdict = ?, details = ?, time_ms = ?, memory_kb = ?,
            judged_at = datetime('now') WHERE id = ?`
  ).run(
    verdict,
    typeof details === 'string' ? details : JSON.stringify(details ?? null),
    Number.isInteger(timeMs) ? timeMs : null,
    Number.isInteger(memoryKb) ? memoryKb : null,
    submissionId
  );
  ws.push(submissionId, { userId: sub.user_id, status: 'done', verdict });
  return { status: 200, body: { ok: true, submissionId, status: 'done', verdict } };
}

function checkJudgeKey(req, res) {
  const key = req.headers['x-judge-key'];
  if (typeof key !== 'string') return res.status(401).json({ error: '评测机凭证缺失' });
  const a = Buffer.from(key);
  const b = Buffer.from(config.judgeApiKey);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({ error: '评测机凭证无效' });
  }
  return null;
}

// GET /api/judge/tasks  任务拉取：返回最早一个待评测任务（含测试数据）
router.get('/tasks', (req, res) => {
  const denied = checkJudgeKey(req, res);
  if (denied) return denied;

  const task = db.tx(() => {
    const row = db
      .prepare(
        `SELECT s.id, s.problem_id AS problemId, s.language, s.source_code AS sourceCode,
                p.is_communication AS isCommunication, p.protocol
         FROM submissions s JOIN problems p ON p.id = s.problem_id
         WHERE s.status = 'pending' ORDER BY s.id ASC LIMIT 1`
      )
      .get();
    if (!row) return null;
    db.prepare(`UPDATE submissions SET status = 'judging' WHERE id = ?`).run(row.id);
    return row;
  });
  if (!task) return res.json({ task: null });
  const testcases = db
    .prepare(
      'SELECT ordinal, input, expected_output AS expectedOutput FROM testcases WHERE problem_id = ? ORDER BY ordinal'
    )
    .all(task.problemId);
  const { isCommunication, protocol, ...rest } = task;
  res.json({ task: { ...rest, isCommunication: !!isCommunication, protocol: isCommunication ? safeParse(protocol) : null, testcases } });
});

// POST /api/judge/results  结果回传：judging → done，写入判定与明细
router.post('/results', (req, res) => {
  const denied = checkJudgeKey(req, res);
  if (denied) return denied;

  const { submissionId, verdict, details, timeMs, memoryKb } = req.body || {};
  if (!Number.isInteger(submissionId)) return res.status(400).json({ error: '缺少 submissionId' });
  if (!VERDICTS.includes(verdict)) return res.status(400).json({ error: 'verdict 需为 AC/WA/TLE/MLE/RE/CE 之一' });

  const out = finishSubmission(submissionId, verdict, details, timeMs, memoryKb);
  res.status(out.status).json(out.body);
});

// ---------- 自助评测通道（纯前端评测机，JWT 鉴权，仅限本人提交） ----------

const selfAuth = requireRole('member', 'admin');

// POST /api/judge/self/claim  认领本人待评测提交：pending → judging，返回完整评测任务包
// judging 且属本人的提交视为上次评测中断，直接重新发放任务包（幂等恢复）；通信题返回 isCommunication + protocol
router.post('/self/claim', ...selfAuth, (req, res) => {
  const { submissionId } = req.body || {};
  if (!Number.isInteger(submissionId)) return res.status(400).json({ error: '缺少 submissionId' });

  const sub = db
    .prepare(
      `SELECT s.id, s.user_id AS userId, s.status, s.problem_id AS problemId,
              s.source_code AS sourceCode, s.language,
              p.is_communication AS isCommunication, p.time_limit_ms AS timeLimitMs, p.memory_limit_mb AS memoryLimitMb,
              p.protocol
       FROM submissions s JOIN problems p ON p.id = s.problem_id WHERE s.id = ?`
    )
    .get(submissionId);
  if (!sub) return res.status(404).json({ error: '提交不存在' });
  if (sub.userId !== req.user.id) return res.status(403).json({ error: '只能认领本人的提交' });
  if (sub.status === 'done') return res.status(400).json({ error: '该提交已评测完成' });

  if (sub.status === 'pending') {
    const claimed = db
      .prepare(`UPDATE submissions SET status = 'judging' WHERE id = ? AND status = 'pending' AND user_id = ?`)
      .run(submissionId, req.user.id);
    if (claimed.changes === 0) return res.status(409).json({ error: '该提交已被认领' });
  }
  // status 为 judging（本人中断后恢复）或刚认领成功：均发放任务包
  const testcases = db
    .prepare('SELECT ordinal, input, expected_output AS expectedOutput FROM testcases WHERE problem_id = ? ORDER BY ordinal')
    .all(sub.problemId);
  res.json({
    submissionId,
    problemId: sub.problemId,
    language: sub.language,
    sourceCode: sub.sourceCode,
    isCommunication: !!sub.isCommunication,
    protocol: sub.isCommunication ? safeParse(sub.protocol) : null,
    timeLimitMs: sub.timeLimitMs,
    memoryLimitMb: sub.memoryLimitMb,
    testcases,
  });
});

// POST /api/judge/self/results  回传本人提交的评测结果：judging → done（幂等）
router.post('/self/results', ...selfAuth, (req, res) => {
  const { submissionId, verdict, details, timeMs, memoryKb } = req.body || {};
  if (!Number.isInteger(submissionId)) return res.status(400).json({ error: '缺少 submissionId' });
  if (!VERDICTS.includes(verdict)) return res.status(400).json({ error: 'verdict 需为 AC/WA/TLE/MLE/RE/CE 之一' });

  const sub = db.prepare('SELECT * FROM submissions WHERE id = ?').get(submissionId);
  if (!sub) return res.status(404).json({ error: '提交不存在' });
  if (sub.user_id !== req.user.id) return res.status(403).json({ error: '只能回传本人提交的评测结果' });

  const out = finishSubmission(submissionId, verdict, details, timeMs, memoryKb);
  res.status(out.status).json(out.body);
});

module.exports = router;
