// admin 模块：用户列表与角色管理（管理员专用）
const express = require('express');
const db = require('../db');
const { requireRole } = require('../middleware/auth');

const router = express.Router();

router.use(requireRole('admin'));

// GET /api/admin/users  用户列表（查看/管理角色）
router.get('/users', (req, res) => {
  const rows = db
    .prepare('SELECT id, username, role, created_at AS createdAt FROM users ORDER BY id')
    .all();
  res.json(rows);
});

// PATCH /api/admin/users/:id/role  调整用户角色 {role: 'member' | 'admin'}
router.patch('/users/:id/role', (req, res) => {
  const { role } = req.body || {};
  if (!['member', 'admin'].includes(role)) return res.status(400).json({ error: 'role 需为 member 或 admin' });
  const userId = Number(req.params.id);
  const user = db.prepare('SELECT id FROM users WHERE id = ?').get(userId);
  if (!user) return res.status(404).json({ error: '用户不存在' });
  if (userId === req.user.id) return res.status(400).json({ error: '不能修改自己的角色' });
  db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, userId);
  res.json({ ok: true, id: userId, role });
});

module.exports = router;
