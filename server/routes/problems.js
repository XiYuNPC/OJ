// problems 模块：题面 CRUD、测试数据绑定（≥3 组校验）、上下架、题解隐藏区
// 可见性规则：游客只看已上架题面；会员额外可见测试数据；管理员可见全部字段（含下架与题解）
const express = require('express');
const db = require('../db');
const { optionalAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

const PUBLISHED_FIELDS = 'id, title, description, time_limit_ms, memory_limit_mb, is_communication, is_published, created_at, updated_at';

// 表单键（camelCase）→ 数据库列名
const COLUMN = {
  timeLimitMs: 'time_limit_ms',
  memoryLimitMb: 'memory_limit_mb',
  solutionVisible: 'solution_visible',
  isPublished: 'is_published',
  isCommunication: 'is_communication',
  background: 'background',
  inputFormat: 'input_format',
  outputFormat: 'output_format',
  hint: 'hint',
};

// 解析并校验题目表单；返回 {error} 或 {fields, testcases}（fields 的键为数据库列名）
function parseProblemBody(body, { partial = false } = {}) {
  const fields = {};
  if (!partial || body.title !== undefined) {
    if (typeof body.title !== 'string' || body.title.trim().length === 0 || body.title.length > 200) {
      return { error: '题目标题需为非空字符串（≤200 字符）' };
    }
    fields.title = body.title.trim();
  }
  for (const [k, v, min, max] of [
    ['timeLimitMs', 1000, 1, 60000],
    ['memoryLimitMb', 64, 1, 4096],
  ]) {
    if (!partial || body[k] !== undefined) {
      const n = Number(body[k] ?? v);
      if (!Number.isInteger(n) || n < min || n > max) return { error: `${k} 需为 ${min}-${max} 的整数` };
      fields[COLUMN[k]] = n;
    }
  }
  if (!partial || body.description !== undefined) {
    if (body.description !== undefined && typeof body.description !== 'string') {
      return { error: '题面 description 需为字符串' };
    }
    fields.description = body.description ?? '';
  }
  if (!partial || body.solution !== undefined) {
    if (body.solution !== undefined && typeof body.solution !== 'string') return { error: '题解 solution 需为字符串' };
    fields.solution = body.solution ?? '';
  }
  if (!partial || body.solutionVisible !== undefined) {
    fields.solution_visible = body.solutionVisible ? 1 : 0;
  }
  if (!partial || body.isPublished !== undefined) {
    // 新建默认上架；partial 模式下按传入值
    fields.is_published = body.isPublished === undefined || body.isPublished ? 1 : 0;
  }
  if (!partial || body.isCommunication !== undefined) {
    fields.is_communication = body.isCommunication ? 1 : 0;
  }
  if (!partial || body.protocol !== undefined) {
    if (body.protocol !== undefined && body.protocol !== null && typeof body.protocol !== 'string') {
      return { error: '协议配置 protocol 需为 JSON 字符串或 null' };
    }
    fields.protocol = body.protocol ?? null;
  }
  for (const k of ['background', 'inputFormat', 'outputFormat', 'hint']) {
    if (!partial || body[k] !== undefined) {
      if (body[k] !== undefined && typeof body[k] !== 'string') return { error: `${k} 需为字符串` };
      fields[COLUMN[k]] = body[k] ?? '';
    }
  }
  let testcases = undefined;
  if (body.testcases !== undefined) {
    if (!Array.isArray(body.testcases) || body.testcases.length < 3) {
      return { error: '测试数据需不少于 3 组' };
    }
    testcases = body.testcases.map((tc, i) => {
      if (!tc || typeof tc.input !== 'string' || typeof tc.expectedOutput !== 'string') {
        return { error: `第 ${i + 1} 组测试数据需包含字符串 input 与 expectedOutput` };
      }
      return { input: tc.input, expectedOutput: tc.expectedOutput, isSample: tc.isSample ? 1 : 0 };
    });
    const bad = testcases.find((x) => x.error);
    if (bad) return { error: bad.error };
  }
  return { fields, testcases };
}

function rowToProblem(row, { withTestcases = false, withSolution = false, withSamples = false } = {}) {
  const p = {
    id: row.id,
    title: row.title,
    description: row.description,
    background: row.background || '',
    inputFormat: row.input_format || '',
    outputFormat: row.output_format || '',
    hint: row.hint || '',
    timeLimitMs: row.time_limit_ms,
    memoryLimitMb: row.memory_limit_mb,
    isCommunication: !!row.is_communication,
    isPublished: !!row.is_published,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (withSolution) {
    p.solution = row.solution;
    p.solutionVisible = !!row.solution_visible;
    p.protocol = row.protocol;
  }
  if (withTestcases) {
    p.testcases = db
      .prepare('SELECT ordinal, input, expected_output AS expectedOutput, is_sample AS isSample FROM testcases WHERE problem_id = ? ORDER BY ordinal')
      .all(row.id);
  }
  if (withSamples) {
    p.samples = db
      .prepare('SELECT ordinal, input, expected_output AS expectedOutput FROM testcases WHERE problem_id = ? AND is_sample = 1 ORDER BY ordinal')
      .all(row.id);
  }
  return p;
}

// POST /api/problems  管理员发布题目
router.post('/', requireRole('admin'), (req, res) => {
  const parsed = parseProblemBody(req.body || {});
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  const { fields, testcases } = parsed;

  const problemId = db.tx(() => {
    const info = db
      .prepare(
        `INSERT INTO problems (title, description, background, input_format, output_format, hint,
                                time_limit_ms, memory_limit_mb, solution, solution_visible,
                                is_published, is_communication, protocol, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        fields.title,
        fields.description,
        fields.background,
        fields.input_format,
        fields.output_format,
        fields.hint,
        fields.time_limit_ms,
        fields.memory_limit_mb,
        fields.solution,
        fields.solution_visible,
        fields.is_published,
        fields.is_communication,
        fields.protocol,
        req.user.id
      );
    const id = Number(info.lastInsertRowid);
    const insTc = db.prepare(
      'INSERT INTO testcases (problem_id, ordinal, input, expected_output, is_sample) VALUES (?, ?, ?, ?, ?)'
    );
    testcases.forEach((tc, i) => insTc.run(id, i + 1, tc.input, tc.expectedOutput, tc.isSample));
    return id;
  });
  const row = db.prepare('SELECT * FROM problems WHERE id = ?').get(problemId);
  res.status(201).json(rowToProblem(row, { withTestcases: true, withSolution: true, withSamples: true }));
});

// GET /api/problems  题目列表（游客/会员看已上架，管理员看全部）
router.get('/', optionalAuth, (req, res) => {
  const isAdmin = req.user && req.user.role === 'admin';
  const rows = isAdmin
    ? db.prepare(`SELECT ${PUBLISHED_FIELDS} FROM problems ORDER BY id DESC`).all()
    : db.prepare(`SELECT ${PUBLISHED_FIELDS} FROM problems WHERE is_published = 1 ORDER BY id DESC`).all();
  res.json(rows.map((r) => rowToProblem(r)));
});

// GET /api/problems/:id  题目详情
router.get('/:id', optionalAuth, (req, res) => {
  const row = db.prepare('SELECT * FROM problems WHERE id = ?').get(Number(req.params.id));
  if (!row) return res.status(404).json({ error: '题目不存在' });
  const isAdmin = req.user && req.user.role === 'admin';
  const isMember = req.user && (req.user.role === 'member' || isAdmin);
  // 游客与会员均不可见下架题目
  if (!row.is_published && !isAdmin) return res.status(404).json({ error: '题目不存在' });
  const withTestcases = isMember;
  const withSolution = isAdmin || (row.solution_visible && isMember);
  // 样例对所有人公开（游客也可见），评测测试数据仅会员可见
  res.json(rowToProblem(row, { withTestcases, withSolution, withSamples: true }));
});

// PATCH /api/problems/:id  管理员编辑 / 上下架（测试数据整体替换）
router.patch('/:id', requireRole('admin'), (req, res) => {
  const problemId = Number(req.params.id);
  const exists = db.prepare('SELECT id FROM problems WHERE id = ?').get(problemId);
  if (!exists) return res.status(404).json({ error: '题目不存在' });

  const parsed = parseProblemBody(req.body || {}, { partial: true });
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  const { fields, testcases } = parsed;

  const keys = Object.keys(fields);
  if (keys.length === 0 && testcases === undefined) {
    return res.status(400).json({ error: '未提供任何可更新字段' });
  }

  db.tx(() => {
    if (keys.length > 0) {
      const sets = keys.map((k) => `${k} = ?`).join(', ');
      const values = keys.map((k) => fields[k]);
      db.prepare(`UPDATE problems SET ${sets}, updated_at = datetime('now') WHERE id = ?`).run(
        ...values,
        problemId
      );
    }
    if (testcases !== undefined) {
      db.prepare('DELETE FROM testcases WHERE problem_id = ?').run(problemId);
      const insTc = db.prepare(
        'INSERT INTO testcases (problem_id, ordinal, input, expected_output, is_sample) VALUES (?, ?, ?, ?, ?)'
      );
      testcases.forEach((tc, i) => insTc.run(problemId, i + 1, tc.input, tc.expectedOutput, tc.isSample));
    }
  });

  const row = db.prepare('SELECT * FROM problems WHERE id = ?').get(problemId);
  res.json(rowToProblem(row, { withTestcases: true, withSolution: true, withSamples: true }));
});

module.exports = router;
