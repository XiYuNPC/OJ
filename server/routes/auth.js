// auth 模块：题库注册（注册后即为会员）、登录（会员/管理员同一入口）
const crypto = require('crypto');
const { promisify } = require('util');
const jwt = require('jsonwebtoken');
const express = require('express');
const db = require('../db');
const config = require('../config');

const router = express.Router();

// 加盐哈希：scrypt(password, salt, 64)，随机盐 16 字节
// 异步 scrypt（libuv 线程池执行），避免 scryptSync 阻塞事件循环拖慢并发登录（差距清单 #5）
const scryptAsync = promisify(crypto.scrypt);
async function hashPassword(password, salt) {
  const buf = await scryptAsync(password, salt, 64);
  return buf.toString('hex');
}

function signToken(user) {
  return jwt.sign({ id: user.id, username: user.username, role: user.role }, config.jwtSecret, {
    expiresIn: config.jwtExpiresIn,
  });
}

// POST /api/auth/register  {username, password}
router.post('/register', async (req, res) => {
  const { username, password } = req.body || {};
  if (typeof username !== 'string' || !/^[A-Za-z0-9_]{3,32}$/.test(username)) {
    return res.status(400).json({ error: '用户名需为 3-32 位字母、数字或下划线' });
  }
  if (typeof password !== 'string' || password.length < 6 || password.length > 64) {
    return res.status(400).json({ error: '密码长度需为 6-64 位' });
  }
  // 先做慢哈希（异步 scrypt），再检查重名 + 插入：检查与插入之间无 await，保持单线程原子性，
  // 避免「并发注册同名用户」在 check-then-act 间隙产生竞态（同步版 scryptSync 无此问题）。
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = await hashPassword(password, salt);

  const exists = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (exists) return res.status(409).json({ error: '用户名已存在' });
  try {
    const info = db
      .prepare('INSERT INTO users (username, password_hash, salt, role) VALUES (?, ?, ?, ?)')
      .run(username, hash, salt, 'member');
    res.status(201).json({ id: Number(info.lastInsertRowid), username, role: 'member' });
  } catch (e) {
    // 极端并发下的唯一约束兜底（正常已被上面的查重挡住）
    if (String((e && e.message) || e).includes('UNIQUE')) {
      return res.status(409).json({ error: '用户名已存在' });
    }
    throw e;
  }
});

// POST /api/auth/login  {username, password}
router.post('/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (typeof username !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ error: '请提供用户名与密码' });
  }
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user) return res.status(401).json({ error: '用户名或密码错误' });

  const attempt = Buffer.from(await hashPassword(password, user.salt), 'hex');
  const stored = Buffer.from(user.password_hash, 'hex');
  if (attempt.length !== stored.length || !crypto.timingSafeEqual(attempt, stored)) {
    return res.status(401).json({ error: '用户名或密码错误' });
  }
  const token = signToken(user);
  res.json({ token, user: { id: user.id, username: user.username, role: user.role } });
});

module.exports = router;
