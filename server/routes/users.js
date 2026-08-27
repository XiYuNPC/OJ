// users 模块：用户公开主页（头像/用户名/做题统计/热力图/已解决与尝试的题目）
// 统计口径：已解决 = verdict='AC' 去重题；尝试 = 提交过但无任何 AC 记录的题（含评测中/未完成）
const express = require('express');
const db = require('../db');

const router = express.Router();

// GET /api/users/:username  用户公开资料与做题统计（游客可见）
router.get('/:username', (req, res) => {
  const user = db
    .prepare('SELECT id, username, role, created_at AS createdAt FROM users WHERE username = ?')
    .get(req.params.username);
  if (!user) return res.status(404).json({ error: '用户不存在' });
  const uid = user.id;

  // 已解决（AC 去重）题目
  const solved = db
    .prepare(
      `SELECT p.id, p.title, p.is_communication AS isCommunication
       FROM submissions s JOIN problems p ON p.id = s.problem_id
       WHERE s.user_id = ? AND s.verdict = 'AC'
       GROUP BY p.id ORDER BY p.id`
    )
    .all(uid);

  // 尝试但未解决（提交过、该题无任何 AC 记录）题目，附最近一次提交的判定与状态
  const attempted = db
    .prepare(
      `SELECT p.id, p.title, p.is_communication AS isCommunication,
              (SELECT s2.verdict FROM submissions s2
               WHERE s2.user_id = ? AND s2.problem_id = p.id
               ORDER BY s2.id DESC LIMIT 1) AS lastVerdict,
              (SELECT s2.status FROM submissions s2
               WHERE s2.user_id = ? AND s2.problem_id = p.id
               ORDER BY s2.id DESC LIMIT 1) AS lastStatus
       FROM submissions s JOIN problems p ON p.id = s.problem_id
       WHERE s.user_id = ?
         AND NOT EXISTS (
           SELECT 1 FROM submissions a
           WHERE a.user_id = s.user_id AND a.problem_id = s.problem_id AND a.verdict = 'AC'
         )
       GROUP BY p.id ORDER BY p.id`
    )
    .all(uid, uid, uid);

  const totalSubmissions = Number(
    db.prepare('SELECT COUNT(*) AS c FROM submissions WHERE user_id = ?').get(uid).c
  );
  const acSubmissions = Number(
    db.prepare("SELECT COUNT(*) AS c FROM submissions WHERE user_id = ? AND verdict = 'AC'").get(uid).c
  );

  // 热力图：最近 365 天每天提交次数（UTC 日期）
  const heatmap = db
    .prepare(
      `SELECT date(created_at) AS date, COUNT(*) AS count
       FROM submissions
       WHERE user_id = ? AND created_at >= datetime('now', '-365 days')
       GROUP BY date(created_at)
       ORDER BY date`
    )
    .all(uid)
    .map((r) => ({ date: r.date, count: Number(r.count) }));
  const endDate = db.prepare("SELECT date('now') AS d").get().d;

  res.json({
    ...user,
    stats: {
      totalSubmissions,
      acSubmissions,
      solvedCount: solved.length,
      attemptedCount: attempted.length,
    },
    solvedProblems: solved,
    attemptedProblems: attempted,
    heatmap,
    endDate,
  });
});

module.exports = router;
