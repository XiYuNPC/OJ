// 启动入口：HTTP + WebSocket 共用端口
const http = require('http');
const config = require('./config');
require('./db'); // 初始化数据库与表结构
const app = require('./app');
const ws = require('./ws');

const server = http.createServer(app);
ws.init(server);

server.listen(config.port, () => {
  console.log(`WebOJ 已启动：http://localhost:${config.port}`);
  console.log(`接口文档：http://localhost:${config.port}/api/docs`);
  console.log(`评测机凭证已生成于 data/.judge-key（或使用环境变量 JUDGE_API_KEY）`);
});
