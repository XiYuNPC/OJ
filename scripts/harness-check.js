// harness 检查脚本：扫描文档与报告中的仓库地址与密钥特征（AGENTS.md 规则 2）
// 用法：node scripts/harness-check.js（npm run harness）
// 通过：打印「harness 检查通过」并以 0 退出；发现违规：输出「文件:行号 + 片段」并以 1 退出
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// 扫描对象：README 与 docs/ 下全部 .md（立项书、接口文档、各天报告、设计文档）
const files = ['README.md'];
const docsDir = path.join(ROOT, 'docs');
if (fs.existsSync(docsDir)) {
  for (const f of fs.readdirSync(docsDir)) {
    if (f.endsWith('.md')) files.push(path.join('docs', f));
  }
}

// 扫描口径（与 AGENTS.md 规则 2 对应；演示账号口令为文档约定内容，不在扫描范围）
const rules = [
  { name: '仓库地址', re: /github\.com\/|gitlab\.com\/|gitee\.com\/|git@|\.git\b/ },
  { name: 'JWT 特征', re: /\beyJ[A-Za-z0-9_-]{10,}/ },
  { name: 'API Key 特征', re: /\bsk-[A-Za-z0-9]{10,}/ },
  { name: '长随机串（疑似密钥/哈希）', re: /\b[0-9a-f]{40,}\b/ },
];

let violations = 0;
for (const rel of files) {
  const abs = path.join(ROOT, rel);
  const lines = fs.readFileSync(abs, 'utf8').split('\n');
  lines.forEach((line, i) => {
    for (const rule of rules) {
      if (rule.re.test(line)) {
        console.log(`[${rule.name}] ${rel}:${i + 1}: ${line.trim().slice(0, 100)}`);
        violations++;
        break;
      }
    }
  });
}

if (violations > 0) {
  console.log(`harness 检查未通过：${violations} 处违规`);
  process.exit(1);
}
console.log(`harness 检查通过：${files.length} 个文件无仓库地址与密钥特征`);
