// SQLite 初始化：Node 内置 node:sqlite（Node ≥ 23.4 免 flag 可用，无原生编译依赖）
// 同步串行写（立项书风险应对 #4）；db.tx(fn) 为事务助手
const { DatabaseSync } = require('node:sqlite');
const config = require('./config');

const db = new DatabaseSync(config.dbPath);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT    NOT NULL UNIQUE,
  password_hash TEXT    NOT NULL,
  salt          TEXT    NOT NULL,
  role          TEXT    NOT NULL DEFAULT 'member' CHECK (role IN ('member','admin')),
  created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS problems (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  title             TEXT    NOT NULL,
  description       TEXT    NOT NULL DEFAULT '',
  background        TEXT    NOT NULL DEFAULT '',   -- 题目背景（可空）
  input_format      TEXT    NOT NULL DEFAULT '',   -- 输入格式
  output_format     TEXT    NOT NULL DEFAULT '',   -- 输出格式
  hint              TEXT    NOT NULL DEFAULT '',   -- 说明/提示（可空）
  time_limit_ms     INTEGER NOT NULL DEFAULT 1000,
  memory_limit_mb   INTEGER NOT NULL DEFAULT 64,
  solution          TEXT    NOT NULL DEFAULT '',   -- 题解隐藏区内容
  solution_visible  INTEGER NOT NULL DEFAULT 0,    -- 0 隐藏（会员不可见）1 显示
  is_published      INTEGER NOT NULL DEFAULT 1,    -- 1 上架 0 下架
  is_communication  INTEGER NOT NULL DEFAULT 0,    -- 通信题标记（两进程函数式，第 6 天启用评测）
  protocol          TEXT,                          -- 通信题协议配置（JSON：函数签名、中间值上限等）
  created_by        INTEGER REFERENCES users(id),
  created_at        TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS testcases (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  problem_id      INTEGER NOT NULL REFERENCES problems(id) ON DELETE CASCADE,
  ordinal         INTEGER NOT NULL,                -- 组序（从 1 起）
  input           TEXT    NOT NULL,
  expected_output TEXT    NOT NULL,
  is_sample       INTEGER NOT NULL DEFAULT 0        -- 1 样例（公开题面可见）0 评测数据
);

CREATE TABLE IF NOT EXISTS submissions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  problem_id  INTEGER NOT NULL REFERENCES problems(id),
  user_id     INTEGER NOT NULL REFERENCES users(id),
  language    TEXT    NOT NULL DEFAULT 'cpp',
  source_code TEXT    NOT NULL,
  is_public   INTEGER NOT NULL DEFAULT 1,          -- 代码公开：1 公开（他人可见代码）0 不公开（仅本人/管理员可见）
  status      TEXT    NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','judging','done')),
  verdict     TEXT,                                -- AC / WA / TLE / MLE / RE / CE
  details     TEXT,                                -- JSON：逐组比对结果或编译错误信息
  time_ms     INTEGER,                             -- 近似值（WASM 口径）
  memory_kb   INTEGER,                             -- 近似值（WASM 口径）
  created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  judged_at   TEXT
);

CREATE TABLE IF NOT EXISTS contests (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  title       TEXT    NOT NULL,
  description TEXT    NOT NULL DEFAULT '',
  start_time  TEXT    NOT NULL,               -- 开始时间（UTC，YYYY-MM-DD HH:MM:SS）
  end_time    TEXT    NOT NULL,               -- 结束时间（UTC）
  is_public   INTEGER NOT NULL DEFAULT 1,     -- 1 公开（游客可见）0 隐藏（仅管理员可见）
  freeze_time TEXT,                           -- 封榜时间（UTC，可空；null=不封榜，封榜后提交冻结、赛后滚榜逐条揭晓）
  created_by  INTEGER REFERENCES users(id),
  created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS contest_problems (
  contest_id INTEGER NOT NULL REFERENCES contests(id) ON DELETE CASCADE,
  problem_id INTEGER NOT NULL REFERENCES problems(id),
  ordinal    INTEGER NOT NULL,                -- 赛题顺序（从 1 起）
  PRIMARY KEY (contest_id, problem_id)
);

CREATE TABLE IF NOT EXISTS contest_announcements (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  contest_id INTEGER NOT NULL REFERENCES contests(id) ON DELETE CASCADE,
  title      TEXT    NOT NULL,
  content    TEXT    NOT NULL DEFAULT '',
  created_by INTEGER REFERENCES users(id),
  created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_submissions_status ON submissions(status, id);
CREATE INDEX IF NOT EXISTS idx_testcases_problem ON testcases(problem_id, ordinal);
`);

// 已有库迁移：为老版本数据库的 submissions 表补 is_public 列（CREATE TABLE IF NOT EXISTS 不会改旧表）
const submissionCols = db.prepare('PRAGMA table_info(submissions)').all();
if (!submissionCols.some((c) => c.name === 'is_public')) {
  db.exec('ALTER TABLE submissions ADD COLUMN is_public INTEGER NOT NULL DEFAULT 1');
}

// 已有库迁移：problems 表 interactor 列改名 protocol（两进程函数式通信题协议配置）
const problemCols = db.prepare('PRAGMA table_info(problems)').all();
if (problemCols.some((c) => c.name === 'interactor') && !problemCols.some((c) => c.name === 'protocol')) {
  db.exec('ALTER TABLE problems RENAME COLUMN interactor TO protocol');
}

// 已有库迁移：题面分模块字段（背景 / 输入格式 / 输出格式 / 说明提示）
const problemColNames = db.prepare('PRAGMA table_info(problems)').all().map((c) => c.name);
for (const col of ['background', 'input_format', 'output_format', 'hint']) {
  if (!problemColNames.includes(col)) {
    db.exec(`ALTER TABLE problems ADD COLUMN ${col} TEXT NOT NULL DEFAULT ''`);
  }
}

// 已有库迁移：testcases 加 is_sample（样例标记，公开题面可见）
const tcCols = db.prepare('PRAGMA table_info(testcases)').all();
if (!tcCols.some((c) => c.name === 'is_sample')) {
  db.exec('ALTER TABLE testcases ADD COLUMN is_sample INTEGER NOT NULL DEFAULT 0');
}

// 已有库迁移：submissions 加 contest_id（比赛内提交标记，NULL=非比赛提交；不加外键，删比赛不级联删提交）
const subCols2 = db.prepare('PRAGMA table_info(submissions)').all();
if (!subCols2.some((c) => c.name === 'contest_id')) {
  db.exec('ALTER TABLE submissions ADD COLUMN contest_id INTEGER');
  db.exec('CREATE INDEX IF NOT EXISTS idx_submissions_contest ON submissions(contest_id, id)');
}

// 已有库迁移：contests 加 freeze_time（封榜时间，UTC，可空；null=不封榜）
const contestCols2 = db.prepare('PRAGMA table_info(contests)').all();
if (!contestCols2.some((c) => c.name === 'freeze_time')) {
  db.exec('ALTER TABLE contests ADD COLUMN freeze_time TEXT');
}

// 事务助手（手动 BEGIN/COMMIT/ROLLBACK，单进程同步模型下足够）
db.tx = function tx(fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
};

module.exports = db;
