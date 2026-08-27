// 后端评测机（多语言）：轮询拉取非浏览器语言（c / python / java）任务，
// 用系统编译器编译运行、逐组比对后回传结果。C++（cpp）仍由浏览器内实时编译处理。
// 用法：node scripts/judge-daemon.js（npm run daemon）
// 环境变量：
//   OJ_BASE        OJ 服务地址（默认 http://127.0.0.1:3000）
//   JUDGE_API_KEY  评测机凭证（默认读 data/.judge-key）
//   OJ_POLL_MS     轮询间隔毫秒（默认 1000）
//
// 安全边界（与立项书一致，本地演示用途）：不提供生产级沙箱，仅做进程超时强杀、
// 输出大小截断与独立临时目录；请勿在不可信网络环境对公网开放本评测机。
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

// ---------- 配置 ----------
const ROOT = path.join(__dirname, '..');
const BASE = process.env.OJ_BASE || 'http://127.0.0.1:3000';
const POLL_MS = Number(process.env.OJ_POLL_MS || 1000);
const COMPILE_TIMEOUT_MS = 15000;
const MAX_OUTPUT_BYTES = 1024 * 1024; // 单组 stdout/stderr 各 1MB 截断

function readJudgeKey() {
  if (process.env.JUDGE_API_KEY) return process.env.JUDGE_API_KEY;
  const p = path.join(ROOT, 'data', '.judge-key');
  if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8').trim();
  return null;
}
const JUDGE_KEY = readJudgeKey();

const isWin = process.platform === 'win32';
const VERDICTS = ['AC', 'WA', 'TLE', 'MLE', 'RE', 'CE'];

// ---------- HTTP（用 Node 原生 http，避免引入依赖） ----------
function httpJson(method, pathname, { body } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(pathname, BASE);
    const headers = { 'x-judge-key': JUDGE_KEY };
    const payload = body === undefined ? null : JSON.stringify(body);
    if (payload !== null) headers['Content-Type'] = 'application/json';
    const req = require('http').request(
      { hostname: url.hostname, port: url.port, path: url.pathname + url.search, method, headers },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(data); } catch (e) { json = null; }
          resolve({ status: res.statusCode, json });
        });
      }
    );
    req.on('error', reject);
    if (payload !== null) req.write(payload);
    req.end();
  });
}

// ---------- 编译 / 运行 ----------
// 运行子进程：stdin 喂入输入，捕获 stdout/stderr（截断），超时强杀。
function runProcess(cmd, args, { cwd, input, timeoutMs }) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, windowsHide: true });
    let stdout = '';
    let stderr = '';
    let killed = false;
    let timedOut = false;
    const t0 = Date.now();

    const timer = setTimeout(() => {
      timedOut = true;
      killed = true;
      try { child.kill('SIGKILL'); } catch (e) {}
    }, timeoutMs);

    child.stdout.on('data', (c) => {
      if (stdout.length < MAX_OUTPUT_BYTES) stdout += c;
    });
    child.stderr.on('data', (c) => {
      if (stderr.length < MAX_OUTPUT_BYTES) stderr += c;
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ error: err.message, returncode: -1, stdout, stderr, timeMs: Date.now() - t0 });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ returncode: code == null ? -1 : code, stdout, stderr, timeMs: Date.now() - t0, timedOut });
    });

    if (input != null) {
      try { child.stdin.write(input); } catch (e) {}
      try { child.stdin.end(); } catch (e) {}
    } else {
      try { child.stdin.end(); } catch (e) {}
    }
  });
}

// 编译源码为可执行文件 / 类文件；返回 { ok, errText, timeMs } 或 { ok:false }
function compile(language, source, workdir) {
  const t0 = Date.now();
  return new Promise((resolve) => {
    let cmd, args;
    if (language === 'c') {
      const exe = path.join(workdir, 'main' + (isWin ? '.exe' : ''));
      fs.writeFileSync(path.join(workdir, 'main.c'), source);
      cmd = 'gcc'; args = ['-std=c11', '-O2', '-o', exe, 'main.c'];
    } else if (language === 'java') {
      // 约定用户类名 Main（public class Main / class Main）
      fs.writeFileSync(path.join(workdir, 'Main.java'), source);
      cmd = 'javac'; args = ['-encoding', 'UTF-8', 'Main.java'];
    } else {
      // python 无编译
      fs.writeFileSync(path.join(workdir, 'main.py'), source);
      resolve({ ok: true, errText: '', timeMs: Date.now() - t0 });
      return;
    }
    runProcess(cmd, args, { cwd: workdir, input: null, timeoutMs: COMPILE_TIMEOUT_MS }).then((r) => {
      if (r.error) resolve({ ok: false, errText: `编译命令不可用：${cmd}（${r.error}）`, timeMs: Date.now() - t0 });
      else if (r.returncode !== 0) resolve({ ok: false, errText: r.stderr || r.stdout, timeMs: Date.now() - t0 });
      else resolve({ ok: true, errText: '', timeMs: Date.now() - t0 });
    });
  });
}

// 运行一组：返回 { returncode, stdout, stderr, timeMs, oom }
function runCase(language, workdir, input, timeLimitMs) {
  let cmd, args;
  if (language === 'c') {
    cmd = path.join(workdir, 'main' + (isWin ? '.exe' : ''));
    args = [];
  } else if (language === 'python') {
    cmd = isWin ? 'python' : 'python3';
    args = [path.join(workdir, 'main.py')];
  } else {
    cmd = 'java'; args = ['-cp', workdir, 'Main'];
  }
  return runProcess(cmd, args, { cwd: workdir, input, timeoutMs: timeLimitMs }).then((r) => ({
    returncode: r.returncode,
    stdout: r.stdout,
    stderr: r.stderr,
    timeMs: r.timeMs,
    timedOut: !!r.timedOut,
    oom: /out of memory|MemoryError|OutOfMemoryError|bad_alloc|cannot allocate/i.test(r.stderr),
  }));
}

// 输出比对：逐行忽略行尾空白、忽略末尾空行（与浏览器评测机口径一致）
function normalize(s) {
  const lines = String(s ?? '').replace(/\r\n/g, '\n').split('\n');
  while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
  return lines.map((l) => l.replace(/[ \t]+$/, '')).join('\n');
}

// ---------- 评测单个任务 ----------
async function judgeTask(task) {
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'weboj-'));
  const t0 = Date.now();
  let verdict = 'AC';
  const details = [];

  try {
    // 编译
    const c = await compile(task.language, task.sourceCode, workdir);
    if (!c.ok) {
      return { verdict: 'CE', details: (c.errText || '编译失败').slice(0, 4000), timeMs: c.timeMs, memoryKb: null };
    }

    // 逐组运行
    let totalMs = 0;
    for (const tc of task.testcases) {
      const r = await runCase(task.language, workdir, tc.input, task.timeLimitMs);
      totalMs += r.timeMs;
      if (r.timedOut) {
        verdict = 'TLE';
        details.push({ ordinal: tc.ordinal, ok: false, input: tc.input, expectedOutput: tc.expectedOutput, actualOutput: '' });
        break;
      }
      if (r.returncode !== 0) {
        verdict = r.oom ? 'MLE' : 'RE';
        details.push({ ordinal: tc.ordinal, ok: false, input: tc.input, expectedOutput: tc.expectedOutput, actualOutput: (r.stderr || r.stdout || '').slice(0, 800) });
        break;
      }
      const ok = normalize(r.stdout) === normalize(tc.expectedOutput);
      if (!ok) {
        verdict = 'WA';
        details.push({ ordinal: tc.ordinal, ok: false, input: tc.input, expectedOutput: tc.expectedOutput, actualOutput: r.stdout.slice(0, 800) });
        break;
      }
      details.push({ ordinal: tc.ordinal, ok: true, input: tc.input, expectedOutput: tc.expectedOutput, actualOutput: r.stdout.slice(0, 800) });
    }
    return { verdict, details, timeMs: totalMs, memoryKb: null };
  } catch (e) {
    return { verdict: 'RE', details: `评测机内部错误：${e && e.message}`, timeMs: Date.now() - t0, memoryKb: null };
  } finally {
    try { fs.rmSync(workdir, { recursive: true, force: true }); } catch (e) {}
  }
}

// ---------- 主循环 ----------
async function pollOnce() {
  let r;
  try {
    r = await httpJson('GET', '/api/judge/tasks?language=c,python,java');
  } catch (e) {
    console.error(`[daemon] 拉取任务失败（${e.message}），${POLL_MS}ms 后重试…`);
    return false;
  }
  if (r.status !== 200) {
    console.error(`[daemon] 拉取任务返回 ${r.status}，请检查 JUDGE_API_KEY 与 OJ_BASE 配置`);
    return false;
  }
  const task = r.json && r.json.task;
  if (!task) return false;

  console.log(`[daemon] 评测 #${task.id}（${task.language}）`);
  const result = await judgeTask(task);
  const body = { submissionId: task.id, verdict: result.verdict, details: result.details };
  if (Number.isInteger(result.timeMs)) body.timeMs = result.timeMs;
  if (Number.isInteger(result.memoryKb)) body.memoryKb = result.memoryKb;
  const back = await httpJson('POST', '/api/judge/results', { body });
  console.log(`[daemon] #${task.id} → ${result.verdict}（回传 ${back.status}）`);
  return true;
}

async function main() {
  if (!JUDGE_KEY) {
    console.error('[daemon] 未找到评测机凭证：请先启动 OJ（npm start）生成 data/.judge-key，或用 JUDGE_API_KEY 指定。');
    process.exit(1);
  }
  console.log(`[daemon] 后端评测机已启动，轮询 ${BASE}/api/judge/tasks?language=c,python,java（间隔 ${POLL_MS}ms）`);
  console.log('[daemon] 支持语言：C（gcc）、Python 3、Java（javac）；C++ 仍由浏览器内实时编译处理。按 Ctrl+C 退出。');
  while (true) {
    const got = await pollOnce();
    await new Promise((r) => setTimeout(r, got ? 0 : POLL_MS));
  }
}

// 导出核心函数，供测试脚本直接复用（单元验证编译运行逻辑）
module.exports = { judgeTask, pollOnce, compile, runCase, normalize };

if (require.main === module) {
  main().catch((e) => {
    console.error('[daemon] 运行失败：', e);
    process.exit(1);
  });
}
