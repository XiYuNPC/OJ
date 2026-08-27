// verify-p6838.js —— P6838 标号方案脚本互验（harness 补强，2026-08-25）
// 用途：枚举所有 n≤N 的有标号树（Prüfer 序列）× 全部有序查询，验证 §8 单计数器 DFS 标号方案
//       （tin/tout + 「c[0] 与 s 比较」判别深度 + 路由分支）与 BFS 算出的正确下一跳一致。
// 背景：第 7 天走查 B3 曾暴露「s 奇偶 ⇔ 深度奇偶」判别依据错误（tin/tout 全为偶、奇数分支死代码），
//       后改为「c[0] > s ⇔ 深度偶 / c[0] < s ⇔ 深度奇」；本脚本枚举全部小树，从数据层面证明
//       判别 + 路由在任意树形上无死角（含兄弟子树靠后访问等多分支场景）。
// 用法：node scripts/verify-p6838.js（npm run verify-p6838）；VERIFY_N 可调最大 n（默认 7）。

// Prüfer 序列 → 树边（n 个节点，编号 0..n-1）
function pruferToEdges(prufer) {
  const n = prufer.length + 2;
  const deg = new Array(n).fill(1);
  for (const x of prufer) deg[x]++;
  const edges = [];
  for (const x of prufer) {
    let leaf = 0;
    while (deg[leaf] !== 1) leaf++;
    edges.push([leaf, x]);
    deg[leaf]--;
    deg[x]--;
  }
  const rest = [];
  for (let i = 0; i < n; i++) if (deg[i] === 1) rest.push(i);
  edges.push([rest[0], rest[1]]);
  return edges;
}

function buildAdj(n, edges) {
  const adj = Array.from({ length: n }, () => []);
  for (const [u, v] of edges) { adj[u].push(v); adj[v].push(u); }
  return adj;
}

// §8 方案：单计数器 DFS，进入 tin、离开 tout（递归，0 为根）
function dfsScheme(adj) {
  const n = adj.length;
  const dep = new Array(n).fill(0);
  const tin = new Array(n);
  const tout = new Array(n);
  let timer = 0;
  function go(v, p) {
    tin[v] = timer++;
    for (const w of adj[v]) if (w !== p) { dep[w] = dep[v] + 1; go(w, v); }
    tout[v] = timer++;
  }
  go(0, -1);
  return { dep, tin, tout };
}

// §8 方案：标号（深度偶取 tin、深度奇取 tout；编号全部为偶，m ≤ 2n-1）
function label(dep, tin, tout) {
  return dep.map((d, i) => (d % 2 === 0 ? tin[i] : tout[i]));
}

// §8 方案：find_next_station（c 为当前站邻居编号升序）
function findNext(s, t, c) {
  if (c[0] > s) {                     // 邻居编号全大于 s ⇔ 深度偶（s=tin，父节点在末尾）
    if (t < s) return c[c.length - 1];
    for (const x of c) if (t <= x) return x;
    return c[c.length - 1];
  } else {                            // 邻居编号全小于 s ⇔ 深度奇（s=tout，父节点在开头）
    if (t > s) return c[0];
    for (let i = c.length - 1; i >= 1; i--) if (c[i] <= t) return c[i];
    return c[0];
  }
}

// BFS 正确下一跳（z → y 路径上 z 的下一站）
function bfsNext(adj, z, y) {
  const n = adj.length;
  const prev = new Array(n).fill(-1);
  prev[z] = z;
  const q = [z];
  for (let head = 0; head < q.length; head++) {
    const u = q[head];
    if (u === y) break;
    for (const w of adj[u]) if (prev[w] === -1) { prev[w] = u; q.push(w); }
  }
  let cur = y;
  while (prev[cur] !== z) cur = prev[cur];
  return cur;
}

const N = Number(process.env.VERIFY_N || 7);

let trees = 0;
let queries = 0;

function verifyTree(n, edges) {
  const adj = buildAdj(n, edges);
  const { dep, tin, tout } = dfsScheme(adj);
  const L = label(dep, tin, tout);
  const seen = new Set();
  for (let i = 0; i < n; i++) {
    if (L[i] < 0 || L[i] > 2 * n - 1 || seen.has(L[i])) {
      throw new Error(`标号非法（重复/越界）：n=${n} L=${JSON.stringify(L)} 边=${JSON.stringify(edges)}`);
    }
    seen.add(L[i]);
  }
  for (let z = 0; z < n; z++) {
    for (let y = 0; y < n; y++) {
      if (z === y) continue;
      const s = L[z];
      const t = L[y];
      const c = adj[z].map((w) => L[w]).sort((a, b) => a - b);
      const got = findNext(s, t, c);
      const want = L[bfsNext(adj, z, y)];
      if (got !== want) {
        throw new Error(
          `判别/路由错误：n=${n} z=${z}→y=${y} s=${s} t=${t} c=[${c.join(', ')}] 返回=${got} 期望=${want}\n` +
          `边=${JSON.stringify(edges)}\n标号=${JSON.stringify(L)}`
        );
      }
      queries++;
    }
  }
  trees++;
}

function enumeratePrufer(n, prefix) {
  if (prefix.length === n - 2) { verifyTree(n, pruferToEdges(prefix)); return; }
  for (let x = 0; x < n; x++) {
    prefix.push(x);
    enumeratePrufer(n, prefix);
    prefix.pop();
  }
}

for (let n = 2; n <= N; n++) enumeratePrufer(n, []);

console.log(`P6838 标号方案互验通过：n=2..${N} 共 ${trees} 棵树、${queries} 次有序查询，判别/路由全部正确`);
