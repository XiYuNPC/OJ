// RBAC 中间件：Bearer JWT 解析 + 按角色放行
const jwt = require('jsonwebtoken');
const config = require('../config');

// 解析 Authorization: Bearer <token>，成功则挂 req.user = {id, username, role}
function authenticate(req, res, next) {
  const header = req.headers.authorization || '';
  const match = header.match(/^Bearer (.+)$/);
  if (!match) return res.status(401).json({ error: '未登录或凭证无效' });
  try {
    req.user = jwt.verify(match[1], config.jwtSecret);
  } catch (e) {
    return res.status(401).json({ error: '未登录或凭证无效' });
  }
  next();
}

// 可选认证：无 token 时以游客身份放行（req.user 为 undefined）；token 无效则 401
function optionalAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const match = header.match(/^Bearer (.+)$/);
  if (!match) return next();
  try {
    req.user = jwt.verify(match[1], config.jwtSecret);
  } catch (e) {
    return res.status(401).json({ error: '凭证无效' });
  }
  next();
}

// 要求已登录且角色在允许列表中（内置 authenticate：先解析 token 再查角色）
function requireRole(...roles) {
  return [
    authenticate,
    (req, res, next) => {
      if (!roles.includes(req.user.role)) return res.status(403).json({ error: '无权访问' });
      next();
    },
  ];
}

module.exports = { authenticate, optionalAuth, requireRole };
