// WebSocket 实时推送：/ws?token=<JWT>
// 连接按角色分组：会员按 userId 订阅本人提交事件；管理员订阅全部提交事件
const { WebSocketServer } = require('ws');
const jwt = require('jsonwebtoken');
const config = require('./config');

let wss = null;
const memberSockets = new Map(); // userId -> Set<ws>
const adminSockets = new Set(); // ws

function init(server) {
  wss = new WebSocketServer({ server, path: '/ws' });
  wss.on('connection', (ws, req) => {
    let user = null;
    try {
      const url = new URL(req.url, 'http://localhost');
      user = jwt.verify(url.searchParams.get('token') || '', config.jwtSecret);
    } catch (e) {
      user = null;
    }
    if (!user) {
      ws.close(4001, '未登录或凭证无效');
      return;
    }
    if (user.role === 'admin') {
      adminSockets.add(ws);
    } else {
      if (!memberSockets.has(user.id)) memberSockets.set(user.id, new Set());
      memberSockets.get(user.id).add(ws);
    }
    ws.on('close', () => {
      adminSockets.delete(ws);
      const set = memberSockets.get(user.id);
      if (set) {
        set.delete(ws);
        if (set.size === 0) memberSockets.delete(user.id);
      }
    });
    ws.on('error', () => {});
  });
}

// 推送给提交者本人（会员）与所有在线管理员
function push(submissionId, payload) {
  const data = JSON.stringify({ type: 'submission', submissionId, ...payload });
  const set = memberSockets.get(payload.userId);
  if (set) for (const ws of set) if (ws.readyState === 1) ws.send(data);
  for (const ws of adminSockets) if (ws.readyState === 1) ws.send(data);
}

module.exports = { init, push };
