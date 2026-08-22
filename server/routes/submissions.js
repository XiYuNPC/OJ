// submissions 模块：提交代码、生成评测任务、查询状态与结果
// 可见性规则：提交列表与评测结果对游客可见；源代码仅本人/管理员/公开提交（is_public=1）可见
const express = require('express');
const db = require('../db');
const { optionalAuth, requireRole } = require('../middleware/auth');
const ws = require('../ws');

const router = express.Router();

const LIST_SQL = `
  SELECT s.id, s.problem_id AS problemId, p.title AS problemTitle, u.username,
         s.language, s.status, s.verdict, s.time_ms AS timeMs, s.memory_kb AS memoryKb,
         s.created_at AS createdAt, s.judged_at AS judgedAt
  FROM submissions s
  JOIN problems p ON p.id = s.problem_id
  JOIN users u ON u.id = s.user_id
`;

// POST /api/submissions  会员/管理员提交代码（isPublic：代码是否公开，默认 1）
router.post('/', requireRole('member', 'admin'), (req, res) => {
  const { problemId, language = 'cpp', sourceCode, isPublic } = req.body || {};
  const problem = db.prepare('SELECT * FROM problems WHERE id = ?').get(Number(problemId));
  if (!problem) return res.status(404).json({ error: '题目不存在' });
  if (!problem.is_published && req.user.role !== 'admin') {
    return res.status(400).json({ error: '题目未上架，不可提交' });
  }
  if (language !== 'cpp') return res.status(400).json({ error: '当前仅支持 C++（cpp）' });
  if (typeof sourceCode !== 'string' || sourceCode.trim().length === 0) {
    return res.status(400).json({ error: '源码不能为空' });
  }
  if (sourceCode.length > 64 * 1024) return res.status(400).json({ error: '源码超过 64KB 限制' });

  const info = db
    .prepare(
      'INSERT INTO submissions (problem_id, user_id, language, source_code, is_public, status) VALUES (?, ?, ?, ?, ?, ?)'
    )
    .run(problem.id, req.user.id, language, sourceCode, isPublic === 0 || isPublic === false ? 0 : 1, 'pending');
  const submissionId = Number(info.lastInsertRowid);
  ws.push(submissionId, { userId: req.user.id, status: 'pending' });
  res.status(201).json({ id: submissionId, status: 'pending' });
});

// GET /api/submissions  提交列表（游客可见全部提交，按提交时间倒序；?problemId= 只看某题）
router.get('/', optionalAuth, (req, res) => {
  const { problemId } = req.query;
  let where = '';
  const params = [];
  if (problemId !== undefined) {
    const pid = Number(problemId);
    if (!Number.isInteger(pid)) return res.status(400).json({ error: 'problemId 需为整数' });
    where = ' WHERE s.problem_id = ?';
    params.push(pid);
  }
  const rows = db.prepare(`${LIST_SQL}${where} ORDER BY s.id DESC LIMIT 200`).all(...params);
  res.json(rows);
});

// GET /api/submissions/:id  提交详情（游客可见评测结果；源代码仅本人/管理员/公开提交可见）
router.get('/:id', optionalAuth, (req, res) => {
  const row = db
    .prepare(
      `SELECT s.id, s.problem_id AS problemId, p.title AS problemTitle, u.username,
              s.language, s.status, s.verdict, s.time_ms AS timeMs, s.memory_kb AS memoryKb,
              s.source_code AS sourceCode, s.is_public AS isPublic, s.details, s.user_id AS userId,
              s.created_at AS createdAt, s.judged_at AS judgedAt
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
