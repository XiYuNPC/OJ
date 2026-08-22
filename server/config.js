// 全局配置：端口、数据库路径、JWT 密钥、评测机 API 凭证
// 密钥类配置首次启动时自动随机生成并存入 data/（已加入 .gitignore，不进仓库、不写在文档里）
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

// 读取或首次生成一个随机秘密值（文件权限 600）
function readOrCreateSecret(name) {
  const p = path.join(DATA_DIR, name);
  if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8').trim();
  const secret = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(p, secret, { mode: 0o600 });
  return secret;
}

module.exports = {
  root: ROOT,
  dataDir: DATA_DIR,
  port: Number(process.env.PORT || 3000),
  dbPath: process.env.DB_PATH || path.join(DATA_DIR, 'weboj.db'),
  jwtSecret: process.env.JWT_SECRET || readOrCreateSecret('.jwt-secret'),
  jwtExpiresIn: '12h',
  judgeApiKey: process.env.JUDGE_API_KEY || readOrCreateSecret('.judge-key'),
};
