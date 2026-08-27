// submissions 模块：提交代码、生成评测任务、查询状态与结果
// 可见性规则：提交列表与评测结果对游客可见；源代码仅本人/管理员/公开提交（is_public=1）可见
const express = require('express');
const db = require('../db');
const { optionalAuth, requireRole } = require('../middleware/auth');
const ws = require('../ws');

const router = express.Router();

// 支持的语言：cpp 走浏览器内实时编译（emception），c / python / java 走后端评测机（系统编译器）
const SUPPORTED_LANGUAGES = ['c', 'cpp', 'python', 'java'];
const LANGUAGE_LABELS = { c: 'C', cpp: 'C++', python: 'Python 3', java: 'Java' };

const LIST_SQL = `
  SELECT s.id, s.problem_id AS problemId, p.title AS problemTitle, u.username,
         s.language, s.status, s.verdict, s.time_ms AS timeMs, s.memory_kb AS memoryKb,
         s.created_at AS createdAt, s.judged_at AS judgedAt, s.contest_id AS contestId
  FROM submissions s
  JOIN problems p ON p.id = s.problem_id
  JOIN users u ON u.id = s.user_id
`;

// 校验比赛提交：比赛存在、题目属于该比赛、比赛进行中（start ≤ now < end）
function validateContestSubmission(contestId, problemId) {
  const contest = db.prepare('SELECT id, start_time, end_time FROM contests WHERE id = ?').get(Number(contestId));
  if (!contest) return { error: '比赛不存在' };
  const inContest = db
    .prepare('SELECT 1 FROM contest_problems WHERE contest_id = ? AND problem_id = ?')
    .get(contest.id, problemId);
  if (!inContest) return { error: '该题目不属于此比赛' };
  const now = db.prepare("SELECT datetime('now') AS now").get().now;
  if (now < contest.start_time) return { error: '比赛尚未开始，暂不可提交' };
  if (now >= contest.end_time) return { error: '比赛已结束，不可提交' };
  return { contestId: contest.id };
}

// POST /api/submissions  会员/管理员提交代码（isPublic：代码是否公开，默认 1；contestId：比赛内提交）
router.post('/', requireRole('member', 'admin'), (req, res) => {
  const { problemId, language = 'cpp', sourceCode, isPublic, contestId } = req.body || {};
  const problem = db.prepare('SELECT * FROM problems WHERE id = ?').get(Number(problemId));
  if (!problem) return res.status(404).json({ error: '题目不存在' });
  if (!problem.is_published && req.user.role !== 'admin') {
    return res.status(400).json({ error: '题目未上架，不可提交' });
  }
  if (!SUPPORTED_LANGUAGES.includes(language)) {
    return res.status(400).json({ error: `不支持的语言：${language}（支持 ${SUPPORTED_LANGUAGES.join(' / ')}）` });
  }
  if (problem.is_communication && language !== 'cpp') {
    return res.status(400).json({ error: '通信题为 C++ 专属（两进程函数式），仅支持 cpp' });
  }
  if (typeof sourceCode !== 'string' || sourceCode.trim().length === 0) {
    return res.status(400).json({ error: '源码不能为空' });
  }
  if (sourceCode.length > 64 * 1024) return res.status(400).json({ error: '源码超过 64KB 限制' });

  let finalContestId = null;
  if (contestId !== undefined && contestId !== null && contestId !== '') {
    const check = validateContestSubmission(contestId, problem.id);
    if (check.error) return res.status(400).json({ error: check.error });
    finalContestId = check.contestId;
  }

  const info = db
    .prepare(
      'INSERT INTO submissions (problem_id, user_id, language, source_code, is_public, status, contest_id) VALUES (?, ?, ?, ?, ?, ?, ?)'
    )
    .run(problem.id, req.user.id, language, sourceCode, isPublic === 0 || isPublic === false ? 0 : 1, 'pending', finalContestId);
  const submissionId = Number(info.lastInsertRowid);
  ws.push(submissionId, { userId: req.user.id, status: 'pending' });
  res.status(201).json({ id: submissionId, status: 'pending', contestId: finalContestId });
});

// GET /api/submissions  提交列表（游客可见全部提交，按提交时间倒序；?problemId= 只看某题；?contestId= 只看某比赛）
router.get('/', optionalAuth, (req, res) => {
  const { problemId, contestId } = req.query;
  const where = [];
  const params = [];
  if (problemId !== undefined) {
    const pid = Number(problemId);
    if (!Number.isInteger(pid)) return res.status(400).json({ error: 'problemId 需为整数' });
    where.push('s.problem_id = ?');
    params.push(pid);
  }
  if (contestId !== undefined) {
    const cid = Number(contestId);
    if (!Number.isInteger(cid)) return res.status(400).json({ error: 'contestId 需为整数' });
    where.push('s.contest_id = ?');
    params.push(cid);
  }
  const whereSql = where.length ? ' WHERE ' + where.join(' AND ') : '';
  const rows = db.prepare(`${LIST_SQL}${whereSql} ORDER BY s.id DESC LIMIT 200`).all(...params);
  res.json(rows);
});

// GET /api/submissions/:id  提交详情（游客可见评测结果；源代码仅本人/管理员/公开提交可见）
router.get('/:id', optionalAuth, (req, res) => {
  const row = db
    .prepare(
      `SELECT s.id, s.problem_id AS problemId, p.title AS problemTitle, u.username,
              s.language, s.status, s.verdict, s.time_ms AS timeMs, s.memory_kb AS memoryKb,
              s.source_code AS sourceCode, s.is_public AS isPublic, s.details, s.user_id AS userId,
              s.created_at AS createdAt, s.judged_at AS judgedAt, s.contest_id AS contestId
       FROM submissions s
       JOIN problems p ON p.id = s.problem_id
       JOIN users u ON u.id = s.user_id
       WHERE s.id = ?`
    )
    .get(Number(req.params.id));
  if (!row) return res.status(404).json({ error: '提交不存在' });

  const canSeeCode = req.user && (req.user.role === 'admin' || row.userId === req.user.id);
  if (!canSeeCode && !row.isPublic) row.sourceCode = null; // 未公开：前端显示「代码未公开」
  delete row.userId;
  if (row.details) {
    try {
      row.details = JSON.parse(row.details);
    } catch (e) {
      /* 保留原文 */
    }
  }
  res.json(row);
});

module.exports = router;
