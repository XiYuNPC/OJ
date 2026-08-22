// Express 应用组装（与启动入口分离，便于自测脚本直接复用）
const path = require('path');
const express = require('express');
const auth = require('./routes/auth');
const problems = require('./routes/problems');
const submissions = require('./routes/submissions');
const judge = require('./routes/judge');
const admin = require('./routes/admin');
const docs = require('./routes/docs');

const app = express();
app.use(express.json({ limit: '1mb' }));

// 前端静态页面（public/，根路径即题库首页）
app.use(express.static(path.join(__dirname, '..', 'public')));

// 浏览器内评测机工具链（emception 包内 ESM 组件与 .pack.br 资源包，由 judge-worker 按需拉取）
app.use('/vendor/emception', express.static(path.join(__dirname, '..', 'node_modules', 'emception'), {
  maxAge: '7d',
  setHeaders(res, filePath) {
    if (filePath.endsWith('.pack.br')) res.setHeader('Content-Type', 'application/octet-stream');
  },
}));

app.use('/api/auth', auth);
app.use('/api/problems', problems);
app.use('/api/submissions', submissions);
app.use('/api/judge', judge);
app.use('/api/admin', admin);
app.use('/api/docs', docs);

// 统一 404 与错误处理
app.use('/api', (req, res) => res.status(404).json({ error: '接口不存在' }));
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: '请求体 JSON 格式错误' });
  console.error(err);
  res.status(500).json({ error: '服务器内部错误' });
});

module.exports = app;
