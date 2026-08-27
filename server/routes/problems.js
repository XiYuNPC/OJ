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

// 通信题协议类型菜单（与 public/js/judge-worker.js 的 PARAM_TYPES / RET_TYPES 保持一致）
const PROTO_PARAM_TYPES = new Set(['string', 'int', 'long long', 'vector<int>']);
const PROTO_RET_TYPES = new Set(['string', 'int', 'long long']);

function isProtoName(v) {
  return typeof v === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(v);
}
function isNonNegativeInteger(v) {
  return (typeof v === 'number' && Number.isInteger(v) && v >= 0) || (typeof v === 'string' && /^\d+$/.test(v));
}

// 归一化单个函数签名：字符串（旧式，走默认签名）或对象 { name, params, ret }（新式）
function normalizeProtoFn(v, key, defName, defParams, defRet, defXParam) {
  if (v === undefined || v === null) return { name: defName, params: defParams, ret: defRet, xParam: defXParam };
  if (typeof v === 'string') {
    if (!isProtoName(v)) return { error: `${key} 需为合法函数名或签名对象` };
    return { name: v, params: defParams, ret: defRet, xParam: defXParam };
  }
  if (typeof v !== 'object' || Array.isArray(v)) return { error: `${key} 需为函数名字符串或签名对象` };
  if (!isProtoName(v.name)) return { error: `${key}.name 需为合法函数名` };
  if (!Array.isArray(v.params) || v.params.length === 0) return { error: `${key}.params 需为非空类型数组` };
  for (const t of v.params) {
    if (!PROTO_PARAM_TYPES.has(t)) return { error: `${key}.params 含不支持的类型：${t}` };
  }
  if (!PROTO_RET_TYPES.has(v.ret)) return { error: `${key}.ret 需为 ${[...PROTO_RET_TYPES].join(' / ')} 之一` };
  return { name: v.name, params: v.params, ret: v.ret, xParam: Number.isInteger(v.xParam) ? v.xParam : defXParam };
}

// 协议结构校验：合法返回 { ok: true }，非法返回 { error }
function validateProtocol(protocol) {
  let obj;
  try {
    obj = JSON.parse(protocol);
  } catch (e) {
    return { error: '协议配置需为合法 JSON' };
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { error: '协议配置需为 JSON 对象' };
  const driver = obj.driver || 'two-phase';
  if (!['two-phase', 'stations'].includes(driver)) return { error: '协议 driver 需为 two-phase 或 stations' };

  if (driver === 'stations') {
    for (const k of ['fn1', 'fn2']) {
      if (!isProtoName(obj[k])) return { error: `stations 协议 ${k} 需为合法函数名字符串` };
    }
    return { ok: true };
  }

  // two-phase：默认签名 fn1(string)→int、fn2(string,int)→int（X 为第二参）
  const fn1 = normalizeProtoFn(obj.fn1, 'fn1', 'Alice', ['string'], 'int');
  if (fn1.error) return fn1;
  const fn2 = normalizeProtoFn(obj.fn2, 'fn2', 'Bob', ['string', 'int'], 'int', 1);
  if (fn2.error) return fn2;
  if (fn2.xParam < 0 || fn2.xParam >= fn2.params.length) {
    return { error: 'fn2.xParam 需为 fn2.params 的有效下标' };
  }
  if (fn2.params[fn2.xParam] !== fn1.ret) {
    return { error: `fn2.params[${fn2.xParam}] 的类型需与 fn1 返回类型一致（${fn1.ret}）` };
  }
  if (obj.xMax !== undefined && !isNonNegativeInteger(obj.xMax)) return { error: 'xMax 需为非负整数' };
  if (obj.maxIntermediateBytes !== undefined && !isNonNegativeInteger(obj.maxIntermediateBytes)) {
    return { error: 'maxIntermediateBytes 需为非负整数' };
  }
  if (obj.mutate !== undefined) {
    if (!obj.mutate || typeof obj.mutate !== 'object' || Array.isArray(obj.mutate)) {
      return { error: 'mutate 需为对象' };
    }
    if (fn1.ret !== 'string') return { error: 'mutate 要求 fn1 返回类型为 string' };
    const m = obj.mutate;
    if (m.type === 'noise-num') {
      if (!(typeof m.ratio === 'number' && m.ratio > 0 && m.ratio <= 1)) return { error: 'mutate.ratio 需为 (0,1] 的数字' };
      if (!Number.isInteger(m.seed)) return { error: 'mutate.seed 需为整数' };
      if (!isNonNegativeInteger(m.min) || !isNonNegativeInteger(m.max)) return { error: 'mutate.min / mutate.max 需为非负整数' };
      if (Number(m.min) > Number(m.max)) return { error: 'mutate.min 需不大于 mutate.max' };
    } else if (m.type === 'delete-edges') {
      if (!(Number.isInteger(m.delete) && m.delete >= 1)) return { error: 'mutate.delete 需为 ≥1 的整数' };
      if (!Number.isInteger(m.seed)) return { error: 'mutate.seed 需为整数' };
      if (m.meta !== undefined && !isNonNegativeInteger(m.meta)) return { error: 'mutate.meta 需为非负整数' };
    } else {
      return { error: "mutate.type 需为 'noise-num' 或 'delete-edges'" };
    }
  }
  return { ok: true };
}

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
    const proto = body.protocol ?? null;
    if (proto !== null && proto !== '') {
      const v = validateProtocol(proto);
      if (v.error) return { error: v.error };
    }
    fields.protocol = proto;
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
// 登录用户额外附 status：'solved'（有 AC）/ 'attempted'（提交过但未 AC）/ null（未做过）
router.get('/', optionalAuth, (req, res) => {
  const isAdmin = req.user && req.user.role === 'admin';
  const rows = isAdmin
    ? db.prepare(`SELECT ${PUBLISHED_FIELDS} FROM problems ORDER BY id DESC`).all()
    : db.prepare(`SELECT ${PUBLISHED_FIELDS} FROM problems WHERE is_published = 1 ORDER BY id DESC`).all();

  // 当前用户做题状态映射（未登录为 null，不附加 status 字段）
  let statusOf = null;
  if (req.user) {
    statusOf = {};
    const solved = new Set(
      db
        .prepare("SELECT DISTINCT problem_id AS pid FROM submissions WHERE user_id = ? AND verdict = 'AC'")
        .all(req.user.id)
        .map((r) => r.pid)
    );
    const tried = db
      .prepare('SELECT DISTINCT problem_id AS pid FROM submissions WHERE user_id = ?')
      .all(req.user.id);
    for (const r of tried) statusOf[r.pid] = solved.has(r.pid) ? 'solved' : 'attempted';
  }

  res.json(
    rows.map((r) => {
      const p = rowToProblem(r);
      if (statusOf) p.status = statusOf[r.id] || null;
      return p;
    })
  );
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
