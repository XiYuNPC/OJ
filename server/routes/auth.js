// auth 模块：题库注册（注册后即为会员）、登录（会员/管理员同一入口）
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const express = require('express');
const db = require('../db');
const config = require('../config');

const router = express.Router();

// 加盐哈希：scrypt(password, salt, 64)，随机盐 16 字节
function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

function signToken(user) {
  return jwt.sign({ id: user.id, username: user.username, role: user.role }, config.jwtSecret, {
    expiresIn: config.jwtExpiresIn,
  });
}

// POST /api/auth/register  {username, password}
router.post('/register', (req, res) => {
  const { username, password } = req.body || {};
  if (typeof username !== 'string' || !/^[A-Za-z0-9_]{3,32}$/.test(username)) {
    return res.status(400).json({ error: '用户名需为 3-32 位字母、数字或下划线' });
  }
  if (typeof password !== 'string' || password.length < 6 || password.length > 64) {
    return res.status(400).json({ error: '密码长度需为 6-64 位' });
  }
  const exists = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (exists) return res.status(409).json({ error: '用户名已存在' });

  const salt = crypto.randomBytes(16).toString('hex');
  const info = db
    .prepare('INSERT INTO users (username, password_hash, salt, role) VALUES (?, ?, ?, ?)')
    .run(username, hashPassword(password, salt), salt, 'member');
  res.status(201).json({ id: Number(info.lastInsertRowid), username, role: 'member' });
});

// POST /api/auth/login  {username, password}
router.post('/login', (req, res) => {
  const { username, password } = req.body || {};
  if (typeof username !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ error: '请提供用户名与密码' });
  }
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user) return res.status(401).json({ error: '用户名或密码错误' });

  const attempt = Buffer.from(hashPassword(password, user.salt), 'hex');
  const stored = Buffer.from(user.password_hash, 'hex');
  if (attempt.length !== stored.length || !crypto.timingSafeEqual(attempt, stored)) {
    return res.status(401).json({ error: '用户名或密码错误' });
  }
  const token = signToken(user);
  res.json({ token, user: { id: user.id, username: user.username, role: user.role } });
});

module.exports = router;
