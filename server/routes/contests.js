// contests 模块：比赛列表（公开/状态）、详情（含赛题）、管理员 CRUD
// 可见性规则：游客只见公开比赛；管理员可见全部（含隐藏比赛与详情）
// 状态口径（UTC）：upcoming（未开始）/ ongoing（进行中）/ ended（已结束）
const express = require('express');
const db = require('../db');
const ws = require('../ws');
const { optionalAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

// 比赛状态：按 UTC 时间字符串比较（datetime('now') 与存储格式一致，字典序即时间序）
const STATUS_SQL = `CASE
  WHEN datetime('now') < start_time THEN 'upcoming'
  WHEN datetime('now') > end_time THEN 'ended'
  ELSE 'ongoing' END`;

// 时间归一化：接受 "YYYY-MM-DDTHH:MM[:SS]" 或 "YYYY-MM-DD HH:MM[:SS]"，统一存 "YYYY-MM-DD HH:MM:SS"
function normalizeTime(s) {
  if (typeof s !== 'string') return null;
  const m = s.trim().match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) return null;
  return `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6] || '00'}`;
}

// 解析并校验比赛表单；返回 {error} 或 {fields, problemIds}（fields 的键为数据库列名）
function parseContestBody(body, { partial = false } = {}) {
  const fields = {};
  if (!partial || body.title !== undefined) {
    if (typeof body.title !== 'string' || body.title.trim().length === 0 || body.title.length > 200) {
      return { error: '比赛标题需为非空字符串（≤200 字符）' };
    }
    fields.title = body.title.trim();
  }
  if (!partial || body.description !== undefined) {
    if (body.description !== undefined && typeof body.description !== 'string') {
      return { error: '比赛描述需为字符串' };
    }
    fields.description = body.description ?? '';
  }
  if (!partial || body.startTime !== undefined) {
    fields.start_time = normalizeTime(body.startTime);
    if (!fields.start_time) {
      return { error: body.startTime === undefined ? '开始时间必填' : '开始时间格式无效（需 YYYY-MM-DDTHH:MM 或 YYYY-MM-DD HH:MM）' };
    }
  }
  if (!partial || body.endTime !== undefined) {
    fields.end_time = normalizeTime(body.endTime);
    if (!fields.end_time) {
      return { error: body.endTime === undefined ? '结束时间必填' : '结束时间格式无效（需 YYYY-MM-DDTHH:MM 或 YYYY-MM-DD HH:MM）' };
    }
  }
  if (!partial || body.isPublic !== undefined) {
    fields.is_public = body.isPublic === undefined || body.isPublic ? 1 : 0;
  }
  if (!partial || body.freezeTime !== undefined) {
    if (body.freezeTime == null || body.freezeTime === '') {
      fields.freeze_time = null; // 未提供或留空 = 不封榜
    } else {
      fields.freeze_time = normalizeTime(body.freezeTime);
      if (!fields.freeze_time) return { error: '封榜时间格式无效（需 YYYY-MM-DDTHH:MM 或 YYYY-MM-DD HH:MM，或留空不封榜）' };
    }
  }
  let problemIds = undefined;
  if (body.problemIds !== undefined) {
    if (!Array.isArray(body.problemIds)) return { error: 'problemIds 需为题目 id 数组' };
    problemIds = [...new Set(body.problemIds.map((x) => Number(x)))];
    if (problemIds.some((x) => !Number.isInteger(x) || x <= 0)) return { error: 'problemIds 需为正整数' };
  }
  return { fields, problemIds };
}

// 校验赛题 id 全部存在（外键约束只做兜底，非法 id 提前返回 400 而不是 500）
function validateProblemIds(problemIds) {
  if (!problemIds || !problemIds.length) return null;
  const stmt = db.prepare('SELECT id FROM problems WHERE id = ?');
  for (const pid of problemIds) {
    if (!stmt.get(pid)) return { error: `题目 #${pid} 不存在` };
  }
  return null;
}

// ACM 罚时单位（分钟）
const PENALTY_PER_WRONG_MIN = 20;

// 时间字符串（UTC "YYYY-MM-DD HH:MM:SS"）→ 毫秒时间戳
function toMs(s) {
  return Date.parse(String(s).replace(' ', 'T') + 'Z');
}

// 计算比赛榜单（ACM/ICPC 规则）：按 AC 数降序、罚时升序、最近 AC 时间升序
// 返回 { problems, rows, submissions }；submissions 为按时间升序的比赛内已完成提交（供滚榜重放）
function computeScoreboard(contestId) {
  const contest = db
    .prepare('SELECT id, title, start_time AS startTime, end_time AS endTime, freeze_time AS freezeTime FROM contests WHERE id = ?')
    .get(contestId);
  if (!contest) return null;

  const problems = db
    .prepare(
      `SELECT cp.ordinal, p.id AS problemId, p.title
       FROM contest_problems cp JOIN problems p ON p.id = cp.problem_id
       WHERE cp.contest_id = ? ORDER BY cp.ordinal, p.id`
    )
    .all(contestId);

  const subs = db
    .prepare(
      `SELECT s.id, s.user_id AS userId, u.username, s.problem_id AS problemId, s.verdict, s.created_at AS createdAt
       FROM submissions s JOIN users u ON u.id = s.user_id
       WHERE s.contest_id = ? AND s.status = 'done'
         AND s.created_at >= ? AND s.created_at <= ?
       ORDER BY s.id ASC`
    )
    .all(contestId, contest.startTime, contest.endTime);

  const startMs = toMs(contest.startTime);
  const users = new Map(); // userId -> { userId, username, solved, penalty, lastAcMs, cells: Map(problemId -> cell) }

  for (const s of subs) {
    if (!users.has(s.userId)) {
      users.set(s.userId, {
        userId: s.userId,
        username: s.username,
        solved: 0,
        penalty: 0,
        lastAcMs: null,
        cells: new Map(),
      });
    }
    const u = users.get(s.userId);
    if (!u.cells.has(s.problemId)) {
      u.cells.set(s.problemId, { problemId: s.problemId, status: null, attempts: 0, wrong: 0, acTime: null });
    }
    const cell = u.cells.get(s.problemId);
    if (cell.status === 'ac') continue; // 已 AC 后忽略后续提交
    cell.attempts++;
    if (s.verdict === 'AC') {
      const acMs = toMs(s.createdAt);
      cell.status = 'ac';
      cell.acTime = Math.max(1, Math.ceil((acMs - startMs) / 60000));
      u.solved++;
      u.penalty += cell.acTime + cell.wrong * PENALTY_PER_WRONG_MIN;
      if (u.lastAcMs === null || acMs > u.lastAcMs) u.lastAcMs = acMs;
    } else if (s.verdict && s.verdict !== 'CE') {
      // 非 AC（且非 CE）计一次错误尝试；CE 不计罚时但计入 attempts
      cell.status = cell.status || 'tried';
      cell.wrong++;
    } else if (s.verdict === 'CE') {
      cell.status = cell.status || 'tried';
    }
  }

  const rows = [...users.values()].map((u) => ({
    userId: u.userId,
    username: u.username,
    solved: u.solved,
    penalty: u.penalty,
    lastAcMs: u.lastAcMs,
    cells: problems.map((p) => {
      const c = u.cells.get(p.problemId);
      return c
        ? { problemId: p.problemId, status: c.status, attempts: c.attempts, wrong: c.wrong, acTime: c.acTime }
        : { problemId: p.problemId, status: null, attempts: 0, wrong: 0, acTime: null };
    }),
  }));

  // 排名：AC 数降序 → 罚时升序 → 最近 AC 时间升序（早者靠前）→ 用户名升序
  rows.sort(
    (a, b) =>
      b.solved - a.solved ||
      a.penalty - b.penalty ||
      (a.lastAcMs ?? Infinity) - (b.lastAcMs ?? Infinity) ||
      a.username.localeCompare(b.username)
  );
  rows.forEach((r, i) => (r.rank = i + 1));

  return {
    contest: { id: contest.id, title: contest.title, startTime: contest.startTime, endTime: contest.endTime, freezeTime: contest.freezeTime },
    problems,
    rows,
    submissions: subs,
  };
}

// 单场比赛完整行（含状态 + 赛题列表）
function contestRow(id) {
  const row = db
    .prepare(
      `SELECT id, title, description, start_time AS startTime, end_time AS endTime,
              freeze_time AS freezeTime, is_public AS isPublic, created_at AS createdAt, ${STATUS_SQL} AS status
       FROM contests WHERE id = ?`
    )
    .get(id);
  if (!row) return null;
  row.isPublic = !!row.isPublic;
  row.problems = db
    .prepare(
      `SELECT p.id, p.title, p.time_limit_ms AS timeLimitMs, p.memory_limit_mb AS memoryLimitMb,
              p.is_communication AS isCommunication, cp.ordinal
       FROM contest_problems cp JOIN problems p ON p.id = cp.problem_id
       WHERE cp.contest_id = ? ORDER BY cp.ordinal, p.id`
    )
    .all(id)
    .map((p) => ({ ...p, isCommunication: !!p.isCommunication }));
  return row;
}

// GET /api/contests  比赛列表（游客/会员见公开，管理员见全部）
router.get('/', optionalAuth, (req, res) => {
  const isAdmin = req.user && req.user.role === 'admin';
  const rows = db
    .prepare(
      `SELECT c.id, c.title, c.description, c.start_time AS startTime, c.end_time AS endTime,
              c.is_public AS isPublic, c.created_at AS createdAt, ${STATUS_SQL} AS status,
              (SELECT COUNT(*) FROM contest_problems cp WHERE cp.contest_id = c.id) AS problemCount
       FROM contests c
       ${isAdmin ? '' : 'WHERE c.is_public = 1'}
       ORDER BY c.id DESC`
    )
    .all()
    .map((r) => ({ ...r, isPublic: !!r.isPublic, problemCount: Number(r.problemCount) }));
  res.json(rows);
});

// GET /api/contests/:id/scoreboard  比赛实时榜单（ACM 规则，游客可见公开比赛）
router.get('/:id/scoreboard', optionalAuth, (req, res) => {
  const isAdmin = req.user && req.user.role === 'admin';
  const row = db.prepare('SELECT id, is_public AS isPublic FROM contests WHERE id = ?').get(Number(req.params.id));
  if (!row) return res.status(404).json({ error: '比赛不存在' });
  if (!row.isPublic && !isAdmin) return res.status(404).json({ error: '比赛不存在' });
  res.json(computeScoreboard(row.id));
});

// GET /api/contests/:id  比赛详情（含赛题列表）
router.get('/:id', optionalAuth, (req, res) => {
  const isAdmin = req.user && req.user.role === 'admin';
  const row = contestRow(Number(req.params.id));
  if (!row) return res.status(404).json({ error: '比赛不存在' });
  if (!row.isPublic && !isAdmin) return res.status(404).json({ error: '比赛不存在' });
  res.json(row);
});

// POST /api/contests  管理员创建比赛
router.post('/', requireRole('admin'), (req, res) => {
  const parsed = parseContestBody(req.body || {});
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  const { fields, problemIds } = parsed;
  if (fields.start_time >= fields.end_time) {
    return res.status(400).json({ error: '结束时间需晚于开始时间' });
  }
  if (fields.freeze_time != null && (fields.freeze_time < fields.start_time || fields.freeze_time > fields.end_time)) {
    return res.status(400).json({ error: '封榜时间需在比赛时间区间内' });
  }
  const badIds = validateProblemIds(problemIds);
  if (badIds) return res.status(400).json(badIds);

  const contestId = db.tx(() => {
    const info = db
      .prepare(
        'INSERT INTO contests (title, description, start_time, end_time, is_public, freeze_time, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)'
      )
      .run(fields.title, fields.description, fields.start_time, fields.end_time, fields.is_public, fields.freeze_time, req.user.id);
    const id = Number(info.lastInsertRowid);
    if (problemIds && problemIds.length) {
      const ins = db.prepare(
        'INSERT INTO contest_problems (contest_id, problem_id, ordinal) VALUES (?, ?, ?)'
      );
      problemIds.forEach((pid, i) => ins.run(id, pid, i + 1));
    }
    return id;
  });
  res.status(201).json(contestRow(contestId));
});

// PATCH /api/contests/:id  管理员编辑（赛题整体替换）
router.patch('/:id', requireRole('admin'), (req, res) => {
  const contestId = Number(req.params.id);
  const exists = db.prepare('SELECT start_time, end_time, freeze_time FROM contests WHERE id = ?').get(contestId);
  if (!exists) return res.status(404).json({ error: '比赛不存在' });

  const parsed = parseContestBody(req.body || {}, { partial: true });
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  const { fields, problemIds } = parsed;

  const keys = Object.keys(fields);
  if (keys.length === 0 && problemIds === undefined) {
    return res.status(400).json({ error: '未提供任何可更新字段' });
  }

  // 合并已有值校验时间区间
  const start = fields.start_time ?? exists.start_time;
  const end = fields.end_time ?? exists.end_time;
  if (start >= end) return res.status(400).json({ error: '结束时间需晚于开始时间' });
  const freeze = fields.freeze_time !== undefined ? fields.freeze_time : exists.freeze_time;
  if (freeze != null && (freeze < start || freeze > end)) {
    return res.status(400).json({ error: '封榜时间需在比赛时间区间内' });
  }
  if (problemIds !== undefined) {
    const badIds = validateProblemIds(problemIds);
    if (badIds) return res.status(400).json(badIds);
  }

  db.tx(() => {
    if (keys.length > 0) {
      const sets = keys.map((k) => `${k} = ?`).join(', ');
      const values = keys.map((k) => fields[k]);
      db.prepare(`UPDATE contests SET ${sets} WHERE id = ?`).run(...values, contestId);
    }
    if (problemIds !== undefined) {
      db.prepare('DELETE FROM contest_problems WHERE contest_id = ?').run(contestId);
      const ins = db.prepare(
        'INSERT INTO contest_problems (contest_id, problem_id, ordinal) VALUES (?, ?, ?)'
      );
      problemIds.forEach((pid, i) => ins.run(contestId, pid, i + 1));
    }
  });

  res.json(contestRow(contestId));
});

// DELETE /api/contests/:id  管理员删除比赛（赛题关联级联删除）
router.delete('/:id', requireRole('admin'), (req, res) => {
  const contestId = Number(req.params.id);
  const exists = db.prepare('SELECT id FROM contests WHERE id = ?').get(contestId);
  if (!exists) return res.status(404).json({ error: '比赛不存在' });
  db.prepare('DELETE FROM contests WHERE id = ?').run(contestId);
  res.json({ ok: true });
});

// ---------- 比赛通知（公告；读公开、写仅管理员；WS 广播 contest-announcement） ----------

// 比赛可见性校验（隐藏比赛对非管理员一律 404，口径与详情/榜单一致）
function contestVisible(contestId, isAdmin) {
  const row = db.prepare('SELECT id, is_public AS isPublic FROM contests WHERE id = ?').get(contestId);
  if (!row) return null;
  if (!row.isPublic && !isAdmin) return null;
  return row;
}

// 通知表单校验；返回 {error} 或 {fields}
function parseAnnouncementBody(body, { partial = false } = {}) {
  const fields = {};
  if (!partial || body.title !== undefined) {
    if (typeof body.title !== 'string' || body.title.trim().length === 0 || body.title.length > 100) {
      return { error: '通知标题需为非空字符串（≤100 字符）' };
    }
    fields.title = body.title.trim();
  }
  if (!partial || body.content !== undefined) {
    if (body.content !== undefined && typeof body.content !== 'string') {
      return { error: '通知内容需为字符串' };
    }
    fields.content = (body.content ?? '').trim();
    if (fields.content.length > 5000) return { error: '通知内容过长（≤5000 字符）' };
  }
  return { fields };
}

const ANNOUNCEMENT_SQL = `
  SELECT a.id, a.title, a.content, a.created_at AS createdAt, u.username AS author
  FROM contest_announcements a LEFT JOIN users u ON u.id = a.created_by`;

// GET /api/contests/:id/announcements  通知列表（新 → 旧）
router.get('/:id/announcements', optionalAuth, (req, res) => {
  const isAdmin = req.user && req.user.role === 'admin';
  const row = contestVisible(Number(req.params.id), isAdmin);
  if (!row) return res.status(404).json({ error: '比赛不存在' });
  const list = db.prepare(`${ANNOUNCEMENT_SQL} WHERE a.contest_id = ? ORDER BY a.id DESC`).all(row.id);
  res.json(list);
});

// POST /api/contests/:id/announcements  管理员发布通知
router.post('/:id/announcements', requireRole('admin'), (req, res) => {
  const contestId = Number(req.params.id);
  const exists = db.prepare('SELECT id FROM contests WHERE id = ?').get(contestId);
  if (!exists) return res.status(404).json({ error: '比赛不存在' });
  const parsed = parseAnnouncementBody(req.body || {});
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  const info = db
    .prepare('INSERT INTO contest_announcements (contest_id, title, content, created_by) VALUES (?, ?, ?, ?)')
    .run(contestId, parsed.fields.title, parsed.fields.content, req.user.id);
  const row = db.prepare(`${ANNOUNCEMENT_SQL} WHERE a.id = ?`).get(Number(info.lastInsertRowid));
  ws.broadcast({ type: 'contest-announcement', contestId });
  res.status(201).json(row);
});

// PATCH /api/contests/:id/announcements/:aid  管理员编辑通知
router.patch('/:id/announcements/:aid', requireRole('admin'), (req, res) => {
  const contestId = Number(req.params.id);
  const aid = Number(req.params.aid);
  const exists = db.prepare('SELECT id FROM contests WHERE id = ?').get(contestId);
  if (!exists) return res.status(404).json({ error: '比赛不存在' });
  const ann = db
    .prepare('SELECT id FROM contest_announcements WHERE id = ? AND contest_id = ?')
    .get(aid, contestId);
  if (!ann) return res.status(404).json({ error: '通知不存在' });
  const parsed = parseAnnouncementBody(req.body || {}, { partial: true });
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  const keys = Object.keys(parsed.fields);
  if (keys.length === 0) return res.status(400).json({ error: '未提供任何可更新字段' });
  const sets = keys.map((k) => `${k} = ?`).join(', ');
  db.prepare(`UPDATE contest_announcements SET ${sets} WHERE id = ?`).run(
    ...keys.map((k) => parsed.fields[k]),
    aid
  );
  ws.broadcast({ type: 'contest-announcement', contestId });
  res.json({ ok: true });
});

// DELETE /api/contests/:id/announcements/:aid  管理员删除通知
router.delete('/:id/announcements/:aid', requireRole('admin'), (req, res) => {
  const contestId = Number(req.params.id);
  const aid = Number(req.params.aid);
  const exists = db.prepare('SELECT id FROM contests WHERE id = ?').get(contestId);
  if (!exists) return res.status(404).json({ error: '比赛不存在' });
  const ann = db
    .prepare('SELECT id FROM contest_announcements WHERE id = ? AND contest_id = ?')
    .get(aid, contestId);
  if (!ann) return res.status(404).json({ error: '通知不存在' });
  db.prepare('DELETE FROM contest_announcements WHERE id = ?').run(aid);
  ws.broadcast({ type: 'contest-announcement', contestId });
  res.json({ ok: true });
});

module.exports = router;
