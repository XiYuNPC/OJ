// judge.js —— 浏览器内评测机的主线程调度器
// 职责：认领本人提交（POST /api/judge/self/claim）→ 启动/复用评测 worker →
//       watchdog 超时强杀（TLE）→ 回传结果（POST /api/judge/self/results）→ 通知页面。
// 要点：
//   - 评测在 worker 内是同步阻塞执行，worker 自身计时器无法触发，超时必须由主线程强杀；
//   - 同一时刻只跑一个提交（串行队列）；done 后复用 worker（免去重复初始化），
//     TLE / 异常后销毁重建；error 时不回传结果，提交保持 judging（后端 claim 幂等，可重试）；
//   - 认领失败（已评测 / 无权）静默跳过。
(function () {
  if (!window.WOJ) return;
  const { api, getUser } = WOJ;

  const INIT_TIMEOUT_MS = 180000;  // 工具链初始化（首次需下载解压几十 MB，慢）
  const COMPILE_TIMEOUT_MS = 90000; // 编译（首次含库转换，较慢）
  const CASE_MARGIN_MS = 3000;      // 每组在题限基础上附加的 WASM 启动裕量
  const COMM_CASE_MARGIN_MS = 6000; // 通信题每组要两次实例化（new JudgeModule ×2），裕量单独加大

  const queue = [];
  const seen = new Set(); // 已入队/评测中的提交 id（本页面内防重复）
  let running = false;
  let worker = null; // 复用的评测 worker（done 后保留；TLE/异常时销毁）

  function emit(name, detail) {
    try {
      document.dispatchEvent(new CustomEvent(name, { detail }));
    } catch (e) {}
  }

  function getWorker() {
    if (worker) return worker;
    worker = new Worker("/js/judge-worker.js", { type: "module" });
    return worker;
  }

  function killWorker() {
    if (worker) {
      try { worker.terminate(); } catch (e) {}
      worker = null;
    }
  }

  // 入队：id 为提交编号；未登录或重复提交直接忽略
  function judge(id) {
    if (!getUser()) return;
    id = Number(id);
    if (!id || seen.has(id)) return;
    seen.add(id);
    queue.push(id);
    pump();
  }

  async function pump() {
    if (running) return;
    running = true;
    try {
      while (queue.length) {
        await judgeOne(queue.shift());
      }
    } finally {
      running = false;
    }
  }

  async function judgeOne(submissionId) {
    // 1) 认领任务包（失败静默：已评测 / 无权 / 已被他人认领）
    let r;
    try {
      r = await api("POST", "/api/judge/self/claim", { submissionId });
    } catch (e) {
      return;
    }
    if (r.status !== 200 || !r.json || !Array.isArray(r.json.testcases)) return;
    const task = r.json;
    emit("weboj-judge-start", { submissionId });

    // 2) 启动 worker 并等待评测完成（watchdog 见 fail）
    let w;
    try {
      w = getWorker();
    } catch (e) {
      emit("weboj-judge-done", { submissionId, verdict: null, error: "浏览器不支持评测 Worker" });
      return;
    }

    const result = await new Promise((resolve) => {
      let bootTimer = setTimeout(() => fail("初始化超时", null), INIT_TIMEOUT_MS);
      let timer = null;
      const doneDetails = []; // worker 回报的已完成组（TLE 时由主线程拼全 details）

      function cleanup() {
        clearTimeout(bootTimer);
        clearTimeout(timer);
      }

      // 超时/异常：强杀 worker，提交按对应判罚处理（error 场景不回传结果）
      function fail(reason, verdict) {
        cleanup();
        killWorker(); // 仅 TLE 与 worker 异常到达这里，环境不可复用
        if (verdict === "TLE") {
          const spent = doneDetails.reduce((s, d) => s + (d.timeMs || 0), 0);
          resolve({
            verdict: "TLE",
            details: task.testcases.map((tc) => {
              const done = doneDetails.find((d) => d.ordinal === tc.ordinal);
              if (done) {
                return { ordinal: tc.ordinal, ok: !!done.ok, input: tc.input, expectedOutput: tc.expectedOutput, actualOutput: done.actualOutput || "" };
              }
              return { ordinal: tc.ordinal, ok: false, input: tc.input, expectedOutput: tc.expectedOutput, actualOutput: "" };
            }),
            timeMs: spent + task.timeLimitMs,
          });
        } else {
          resolve({ error: reason });
        }
      }

      w.onmessage = (e) => {
        const m = e.data || {};
        switch (m.type) {
          case "init-start":
            break;
          case "init-done":
            clearTimeout(bootTimer);
            break;
          case "compile-start":
            clearTimeout(timer);
            timer = setTimeout(() => fail("编译超时", null), COMPILE_TIMEOUT_MS);
            break;
          case "compile-done":
            clearTimeout(timer);
            break;
          case "case-start":
            clearTimeout(timer);
            emit("weboj-judge-progress", { submissionId, phase: "case-start", ordinal: m.ordinal, total: m.total });
            timer = setTimeout(
              () => fail("运行超时", "TLE"),
              task.timeLimitMs + (task.isCommunication ? COMM_CASE_MARGIN_MS : CASE_MARGIN_MS)
            );
            break;
          case "case-done":
            clearTimeout(timer);
            doneDetails.push(m);
            emit("weboj-judge-progress", { submissionId, phase: "case-done", ordinal: m.ordinal, ok: m.ok, actualOutput: m.actualOutput, timeMs: m.timeMs });
            // 组间间隙（写输入文件等）也设宽裕保护，防止 worker 无声挂死
            timer = setTimeout(() => fail("评测线程无响应", null), 30000);
            break;
          case "done":
            cleanup();
            resolve({ verdict: m.verdict, details: m.details, timeMs: m.timeMs, memoryKb: m.memoryKb });
            break;
          case "error":
            cleanup();
            killWorker();
            resolve({ error: m.message });
            break;
        }
      };

      w.onerror = (e) => {
        cleanup();
        killWorker();
        resolve({ error: "评测线程异常：" + (e.message || "未知错误") });
      };

      w.postMessage({ type: "start", task });
    });

    // 3) 回传结果（error 时不回传，提交保持 judging，下次加载可重新认领）
    if (!result.error && result.verdict) {
      const body = { submissionId, verdict: result.verdict, details: result.details };
      if (Number.isInteger(result.timeMs)) body.timeMs = result.timeMs;
      if (Number.isInteger(result.memoryKb)) body.memoryKb = result.memoryKb;
      await api("POST", "/api/judge/self/results", body);
    }

    emit("weboj-judge-done", {
      submissionId,
      verdict: result.verdict || null,
      error: result.error || null,
      timeMs: result.timeMs,
    });
  }

  // 页面卸载时回收 worker（提交保持 judging，下次进入页面自动恢复评测）
  window.addEventListener("beforeunload", () => killWorker());

  window.WOJJudge = { judge };
})();
