// 管理后台逻辑：题目管理（列表/新建/编辑/上下架）、用户角色、提交总览
(function () {
  const { api, esc, toast, renderNav, getUser, fmtTime, verdictBadge, statusText } = WOJ;

  // 非管理员：回到首页
  const user = getUser();
  if (!user || user.role !== 'admin') {
    location.href = '/login.html?next=' + encodeURIComponent('/admin.html');
    return;
  }
  renderNav('admin');

  // ---------- 标签页 ----------
  const tabs = { problems: 'tab-problems', contests: 'tab-contests', users: 'tab-users', subs: 'tab-subs' };
  document.querySelectorAll('.tab').forEach((t) => {
    t.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x === t));
      Object.entries(tabs).forEach(([key, sec]) => {
        document.getElementById(sec).classList.toggle('hidden', key !== t.dataset.tab);
      });
      if (t.dataset.tab === 'problems') loadProblems();
      if (t.dataset.tab === 'contests') loadContests();
      if (t.dataset.tab === 'users') loadUsers();
      if (t.dataset.tab === 'subs') loadSubs();
    });
  });

  // ---------- 题目管理 ----------
  let editingId = null;

  function ioRow(tc) {
    const div = document.createElement('div');
    div.className = 'flex';
    div.style.cssText = 'gap:8px;margin-bottom:8px;';
    div.innerHTML = `
      <input type="text" class="tc-in" placeholder="输入（一行一个整数，以换行结尾）" value="${esc(tc && tc.input || '')}" style="flex:2;font-family:var(--font-mono);font-size:13px;padding:6px 8px;border:1px solid var(--line-strong);border-radius:6px;">
      <input type="text" class="tc-out" placeholder="期望输出" value="${esc(tc && tc.expectedOutput || '')}" style="flex:1;font-family:var(--font-mono);font-size:13px;padding:6px 8px;border:1px solid var(--line-strong);border-radius:6px;">
      <button class="btn btn-sm btn-danger tc-del" type="button">删除</button>`;
    div.querySelector('.tc-del').addEventListener('click', () => div.remove());
    return div;
  }

  // 收集某个区块（样例 / 测试数据）的非空行，isSample 标记由区块决定
  function collectRows(containerId, isSample) {
    const rows = document.querySelectorAll('#' + containerId + ' > div');
    const tcs = [];
    rows.forEach((row) => {
      const input = row.querySelector('.tc-in').value;
      const expectedOutput = row.querySelector('.tc-out').value;
      if (input !== '' || expectedOutput !== '') tcs.push({ input, expectedOutput, isSample });
    });
    return tcs;
  }

  function collectTestcases() {
    // 样例在前（ordinal 靠前），评测测试数据在后
    return collectRows('sample-rows', 1).concat(collectRows('tc-rows', 0));
  }

  // ---------- 协议配置：结构化表单 ↔ JSON 双模式 ----------
  function protocolMode() {
    return document.getElementById('proto-form-btn').classList.contains('active') ? 'form' : 'json';
  }
  function setProtocolMode(mode) {
    const form = mode === 'form';
    document.getElementById('proto-form-btn').classList.toggle('active', form);
    document.getElementById('proto-json-btn').classList.toggle('active', !form);
    document.getElementById('proto-form').classList.toggle('hidden', !form);
    document.getElementById('f-protocol').classList.toggle('hidden', form);
    document.getElementById('proto-driver').dispatchEvent(new Event('change'));
  }
  function parseProtoFn(v, defName, defParams, defRet, defXParam) {
    if (v === undefined || v === null) return { name: defName, params: defParams, ret: defRet, xParam: defXParam };
    if (typeof v === 'string') return { name: v, params: defParams, ret: defRet, xParam: defXParam };
    return {
      name: v.name || defName,
      params: Array.isArray(v.params) ? v.params : defParams,
      ret: v.ret || defRet,
      xParam: Number.isInteger(v.xParam) ? v.xParam : defXParam,
    };
  }
  function parseProtoParams(str) {
    return String(str || '').split(',').map((s) => s.trim()).filter(Boolean);
  }
  // JSON 文本 → 表单字段
  function fillFormFromJson(json) {
    let obj = {};
    try { obj = json ? JSON.parse(json) : {}; } catch (e) { obj = {}; }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) obj = {};
    const driver = obj.driver === 'stations' ? 'stations' : 'two-phase';
    document.getElementById('proto-driver').value = driver;
    if (driver === 'stations') {
      document.getElementById('proto-st-fn1').value = obj.fn1 || 'label';
      document.getElementById('proto-st-fn2').value = obj.fn2 || 'find_next_station';
    } else {
      const fn1 = parseProtoFn(obj.fn1, 'Alice', ['string'], 'int');
      const fn2 = parseProtoFn(obj.fn2, 'Bob', ['string', 'int'], 'int', 1);
      document.getElementById('proto-fn1-name').value = fn1.name;
      document.getElementById('proto-fn1-params').value = fn1.params.join(', ');
      document.getElementById('proto-fn1-ret').value = fn1.ret;
      document.getElementById('proto-fn2-name').value = fn2.name;
      document.getElementById('proto-fn2-params').value = fn2.params.join(', ');
      document.getElementById('proto-fn2-ret').value = fn2.ret;
      document.getElementById('proto-fn2-xparam').value = fn2.xParam;
      document.getElementById('proto-xmax').value = obj.xMax !== undefined ? obj.xMax : 1048575;
      document.getElementById('proto-maxbytes').value = obj.maxIntermediateBytes !== undefined ? obj.maxIntermediateBytes : 1024;
    }
  }
  // 表单字段 → JSON 文本
  function buildJsonFromForm() {
    const driver = document.getElementById('proto-driver').value;
    if (driver === 'stations') {
      return JSON.stringify({
        driver: 'stations',
        fn1: document.getElementById('proto-st-fn1').value.trim() || 'label',
        fn2: document.getElementById('proto-st-fn2').value.trim() || 'find_next_station',
      });
    }
    const fn1Params = parseProtoParams(document.getElementById('proto-fn1-params').value);
    const fn2Params = parseProtoParams(document.getElementById('proto-fn2-params').value);
    const xParam = Number(document.getElementById('proto-fn2-xparam').value);
    return JSON.stringify({
      driver: 'two-phase',
      fn1: {
        name: document.getElementById('proto-fn1-name').value.trim() || 'Alice',
        params: fn1Params.length ? fn1Params : ['string'],
        ret: document.getElementById('proto-fn1-ret').value,
      },
      fn2: {
        name: document.getElementById('proto-fn2-name').value.trim() || 'Bob',
        params: fn2Params.length ? fn2Params : ['string', 'int'],
        xParam: Number.isInteger(xParam) ? xParam : 1,
        ret: document.getElementById('proto-fn2-ret').value,
      },
      xMax: Number(document.getElementById('proto-xmax').value) || 1048575,
      maxIntermediateBytes: Number(document.getElementById('proto-maxbytes').value) || 1024,
    });
  }

  function openForm(problem) {
    editingId = problem ? problem.id : null;
    document.getElementById('form-title').textContent = problem ? '编辑题目 #' + problem.id : '发布题目';
    document.getElementById('f-title').value = problem ? problem.title : '';
    document.getElementById('f-bg').value = problem ? (problem.background || '') : '';
    document.getElementById('f-desc').value = problem ? problem.description : '';
    document.getElementById('f-input-format').value = problem ? (problem.inputFormat || '') : '';
    document.getElementById('f-output-format').value = problem ? (problem.outputFormat || '') : '';
    document.getElementById('f-hint').value = problem ? (problem.hint || '') : '';
    document.getElementById('f-solution').value = problem ? (problem.solution || '') : '';
    document.getElementById('f-time').value = problem ? problem.timeLimitMs : 1000;
    document.getElementById('f-mem').value = problem ? problem.memoryLimitMb : 64;
    document.getElementById('f-sol-visible').checked = problem ? !!problem.solutionVisible : false;
    document.getElementById('f-published').checked = problem ? !!problem.isPublished : true;
    document.getElementById('f-comm').checked = problem ? !!problem.isCommunication : false;
    document.getElementById('f-protocol').value = problem ? (problem.protocol || '') : '';
    fillFormFromJson(document.getElementById('f-protocol').value);
    setProtocolMode('form');
    const sampleRows = document.getElementById('sample-rows');
    const tcRows = document.getElementById('tc-rows');
    sampleRows.innerHTML = '';
    tcRows.innerHTML = '';
    const tcs = problem && problem.testcases ? problem.testcases : [];
    const samples = tcs.filter((tc) => tc.isSample);
    const judges = tcs.filter((tc) => !tc.isSample);
    if (problem) {
      samples.forEach((tc) => sampleRows.appendChild(ioRow(tc)));
      judges.forEach((tc) => tcRows.appendChild(ioRow(tc)));
    } else {
      // 新建：测试数据预置 3 空行，样例区留空
      [{}, {}, {}].forEach((tc) => tcRows.appendChild(ioRow(tc)));
    }
    document.getElementById('form-err').classList.add('hidden');
    document.getElementById('problem-form').classList.remove('hidden');
    document.getElementById('problem-form').scrollIntoView({ behavior: 'smooth' });
  }

  function closeForm() {
    document.getElementById('problem-form').classList.add('hidden');
    editingId = null;
  }

  async function saveProblem() {
    const err = (msg) => {
      const el = document.getElementById('form-err');
      el.textContent = msg;
      el.classList.remove('hidden');
    };
    const title = document.getElementById('f-title').value.trim();
    if (!title) return err('标题不能为空');
    const tcs = collectTestcases();
    const judgeCount = collectRows('tc-rows', 0).length;
    if (judgeCount < 3) return err(`评测测试数据至少 3 组（当前 ${judgeCount} 组）`);
    const isComm = document.getElementById('f-comm').checked;
    if (isComm && protocolMode() === 'form') {
      document.getElementById('f-protocol').value = buildJsonFromForm();
    }
    const body = {
      title,
      description: document.getElementById('f-desc').value,
      background: document.getElementById('f-bg').value,
      inputFormat: document.getElementById('f-input-format').value,
      outputFormat: document.getElementById('f-output-format').value,
      hint: document.getElementById('f-hint').value,
      solution: document.getElementById('f-solution').value,
      timeLimitMs: Number(document.getElementById('f-time').value),
      memoryLimitMb: Number(document.getElementById('f-mem').value),
      solutionVisible: document.getElementById('f-sol-visible').checked,
      isPublished: document.getElementById('f-published').checked,
      isCommunication: isComm,
      protocol: isComm ? (document.getElementById('f-protocol').value.trim() || null) : null,
      testcases: tcs,
    };
    const r = editingId
      ? await api('PATCH', '/api/problems/' + editingId, body)
      : await api('POST', '/api/problems', body);
    if (r.status !== 200 && r.status !== 201) return err(r.json && r.json.error || '保存失败');
    toast(editingId ? '已保存修改' : '题目已发布');
    closeForm();
    loadProblems();
  }

  async function loadProblems() {
    const r = await api('GET', '/api/problems');
    const box = document.getElementById('problem-list');
    if (r.status !== 200) {
      box.innerHTML = `<div class="empty">加载失败：${esc(r.json && r.json.error || '')}</div>`;
      return;
    }
    const rows = r.json;
    document.getElementById('problem-count').textContent = `共 ${rows.length} 道题目`;
    if (!rows.length) {
      box.innerHTML = '<div class="empty">还没有题目。点右上角「发布题目」创建第一道题。</div>';
      return;
    }
    box.innerHTML = `
      <table class="table">
        <thead><tr>
          <th>#</th><th>标题</th><th>限制</th><th>类型</th><th>状态</th><th>操作</th>
        </tr></thead>
        <tbody>
          ${rows.map((p) => `
            <tr>
              <td class="mono">P${String(p.id).padStart(4, '0')}</td>
              <td><a href="/problem.html?id=${p.id}">${esc(p.title)}</a></td>
              <td class="mono small">${esc(p.timeLimitMs)}ms / ${esc(p.memoryLimitMb)}MB</td>
              <td>${p.isCommunication ? '<span class="chip chip-comm">通信题</span>' : '<span class="chip">普通</span>'}</td>
              <td>${p.isPublished ? '<span class="small" style="color:var(--ac);">上架</span>' : '<span class="small muted">下架</span>'}</td>
              <td class="small">
                <a href="#" class="edit" data-id="${p.id}">编辑</a> ·
                <a href="#" class="toggle" data-id="${p.id}" data-now="${p.isPublished ? 1 : 0}">${p.isPublished ? '下架' : '上架'}</a>
              </td>
            </tr>`).join('')}
        </tbody>
      </table>`;

    box.querySelectorAll('.edit').forEach((a) => {
      a.addEventListener('click', async (e) => {
        e.preventDefault();
        // 拉取完整详情（含 testcases/solution/背景/格式/提示），保证表单回填齐全
        const r = await api('GET', '/api/problems/' + a.dataset.id);
        if (r.status !== 200) {
          toast(r.json && r.json.error || '加载题目失败', 'err');
          return;
        }
        openForm(r.json);
      });
    });
    box.querySelectorAll('.toggle').forEach((a) => {
      a.addEventListener('click', async (e) => {
        e.preventDefault();
        const isPublished = a.dataset.now === '0';
        const r2 = await api('PATCH', '/api/problems/' + a.dataset.id, { isPublished });
        if (r2.status === 200) {
          toast(isPublished ? '已上架' : '已下架');
          loadProblems();
        } else {
          toast(r2.json && r2.json.error || '操作失败', 'err');
        }
      });
    });
  }

  // ---------- 比赛管理 ----------
  let editingContestId = null;

  // 本地时间 "YYYY-MM-DDTHH:MM" → 数据库 UTC "YYYY-MM-DD HH:MM:SS"
  function toDbTime(local) {
    if (!local) return null;
    const d = new Date(local);
    if (isNaN(d)) return null;
    return d.toISOString().slice(0, 19).replace('T', ' ');
  }
  // 数据库 UTC "YYYY-MM-DD HH:MM:SS" → 本地时间 "YYYY-MM-DDTHH:MM"
  function toLocalInput(dbTime) {
    if (!dbTime) return '';
    const d = new Date(dbTime.replace(' ', 'T') + 'Z');
    if (isNaN(d)) return '';
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  const CT_STATUS = {
    upcoming: { text: '未开始', color: 'var(--ink-soft)' },
    ongoing: { text: '进行中', color: 'var(--ac)' },
    ended: { text: '已结束', color: 'var(--ink-soft)' },
  };

  async function renderContestPicker(selected) {
    const box = document.getElementById('ct-problem-picker');
    const r = await api('GET', '/api/problems');
    if (r.status !== 200) {
      box.innerHTML = `<span class="small muted">加载题目失败：${esc(r.json && r.json.error || '')}</span>`;
      return;
    }
    const rows = r.json;
    if (!rows.length) {
      box.innerHTML = '<span class="small muted">暂无题目，请先在「题目管理」发布题目。</span>';
      return;
    }
    box.innerHTML = rows
      .map(
        (p) => `
        <label class="check ct-picker-item">
          <input type="checkbox" class="ct-pick" value="${p.id}" ${selected.includes(p.id) ? 'checked' : ''}>
          <span class="mono small">P${String(p.id).padStart(4, '0')}</span>
          <span style="flex:1;">${esc(p.title)}</span>
        </label>`
      )
      .join('');
  }

  function openContestForm(contest) {
    editingContestId = contest ? contest.id : null;
    document.getElementById('contest-form-title').textContent = contest ? '编辑比赛 #' + contest.id : '创建比赛';
    document.getElementById('ct-f-title').value = contest ? contest.title : '';
    document.getElementById('ct-f-desc').value = contest ? (contest.description || '') : '';
    document.getElementById('ct-f-start').value = contest ? toLocalInput(contest.startTime) : '';
    document.getElementById('ct-f-end').value = contest ? toLocalInput(contest.endTime) : '';
    document.getElementById('ct-f-freeze').value = contest ? toLocalInput(contest.freezeTime || '') : '';
    document.getElementById('ct-f-public').checked = contest ? !!contest.isPublic : true;
    document.getElementById('ct-form-err').classList.add('hidden');
    document.getElementById('contest-form').classList.remove('hidden');
    const selected = contest && contest.problems ? contest.problems.map((p) => p.id) : [];
    renderContestPicker(selected);
    document.getElementById('contest-form').scrollIntoView({ behavior: 'smooth' });
  }

  function closeContestForm() {
    document.getElementById('contest-form').classList.add('hidden');
    editingContestId = null;
  }

  async function saveContest() {
    const err = (msg) => {
      const el = document.getElementById('ct-form-err');
      el.textContent = msg;
      el.classList.remove('hidden');
    };
    const title = document.getElementById('ct-f-title').value.trim();
    if (!title) return err('标题不能为空');
    const startTime = toDbTime(document.getElementById('ct-f-start').value);
    const endTime = toDbTime(document.getElementById('ct-f-end').value);
    const freezeTime = toDbTime(document.getElementById('ct-f-freeze').value); // 空 → null（不封榜）
    if (!startTime) return err('开始时间必填');
    if (!endTime) return err('结束时间必填');
    const problemIds = [...document.querySelectorAll('.ct-pick:checked')].map((x) => Number(x.value));
    const body = {
      title,
      description: document.getElementById('ct-f-desc').value,
      startTime,
      endTime,
      freezeTime,
      isPublic: document.getElementById('ct-f-public').checked,
      problemIds,
    };
    const r = editingContestId
      ? await api('PATCH', '/api/contests/' + editingContestId, body)
      : await api('POST', '/api/contests', body);
    if (r.status !== 200 && r.status !== 201) return err(r.json && r.json.error || '保存失败');
    toast(editingContestId ? '已保存修改' : '比赛已创建');
    closeContestForm();
    loadContests();
  }

  async function loadContests() {
    const r = await api('GET', '/api/contests');
    const box = document.getElementById('contest-list');
    if (r.status !== 200) {
      box.innerHTML = `<div class="empty">加载失败：${esc(r.json && r.json.error || '')}</div>`;
      return;
    }
    const rows = r.json;
    document.getElementById('contest-count').textContent = `共 ${rows.length} 场比赛`;
    if (!rows.length) {
      box.innerHTML = '<div class="empty">还没有比赛。点右上角「创建比赛」创建第一场。</div>';
      return;
    }
    box.innerHTML = `
      <table class="table">
        <thead><tr>
          <th>#</th><th>标题</th><th>状态</th><th>时间</th><th>赛题</th><th>可见</th><th>操作</th>
        </tr></thead>
        <tbody>
          ${rows.map((c) => {
            const s = CT_STATUS[c.status] || { text: c.status, color: 'var(--ink-soft)' };
            return `
            <tr>
              <td class="mono">${c.id}</td>
              <td><a href="/contest.html?id=${c.id}">${esc(c.title)}</a></td>
              <td><span class="small" style="color:${s.color};">${s.text}</span></td>
              <td class="mono small">${esc(fmtTime(c.startTime))} → ${esc(fmtTime(c.endTime))}</td>
              <td class="mono small">${c.problemCount} 题</td>
              <td>${c.isPublic ? '<span class="small" style="color:var(--ac);">公开</span>' : '<span class="small muted">隐藏</span>'}</td>
              <td class="small">
                <a href="#" class="ct-edit" data-id="${c.id}">编辑</a> ·
                <a href="#" class="ct-del" data-id="${c.id}">删除</a>
              </td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>`;

    box.querySelectorAll('.ct-edit').forEach((a) => {
      a.addEventListener('click', async (e) => {
        e.preventDefault();
        const r2 = await api('GET', '/api/contests/' + a.dataset.id);
        if (r2.status !== 200) {
          toast(r2.json && r2.json.error || '加载比赛失败', 'err');
          return;
        }
        openContestForm(r2.json);
      });
    });
    box.querySelectorAll('.ct-del').forEach((a) => {
      a.addEventListener('click', async (e) => {
        e.preventDefault();
        if (!confirm('确认删除该比赛？其赛题关联将一并移除（不影响题目本身）。')) return;
        const r2 = await api('DELETE', '/api/contests/' + a.dataset.id);
        if (r2.status === 200) {
          toast('已删除比赛');
          loadContests();
        } else {
          toast(r2.json && r2.json.error || '删除失败', 'err');
        }
      });
    });
  }

  // ---------- 用户管理 ----------
  async function loadUsers() {
    const r = await api('GET', '/api/admin/users');
    const box = document.getElementById('user-list');
    if (r.status !== 200) {
      box.innerHTML = `<div class="empty">加载失败：${esc(r.json && r.json.error || '')}</div>`;
      return;
    }
    const rows = r.json;
    box.innerHTML = `
      <table class="table">
        <thead><tr><th>ID</th><th>用户名</th><th>角色</th><th>注册时间</th><th>操作</th></tr></thead>
        <tbody>
          ${rows.map((u) => `
            <tr>
              <td class="mono">${u.id}</td>
              <td class="mono">${esc(u.username)}</td>
              <td class="mono small">${esc(u.role)}</td>
              <td class="mono small">${esc(fmtTime(u.createdAt))}</td>
              <td>
                ${u.username === getUser().username
                  ? '<span class="small muted">当前账号</span>'
                  : `<select class="role-select small" data-id="${u.id}" style="font-size:13px;padding:3px 6px;border:1px solid var(--line-strong);border-radius:5px;">
                      <option value="member" ${u.role === 'member' ? 'selected' : ''}>member</option>
                      <option value="admin" ${u.role === 'admin' ? 'selected' : ''}>admin</option>
                    </select>`}
              </td>
            </tr>`).join('')}
        </tbody>
      </table>`;
    box.querySelectorAll('.role-select').forEach((sel) => {
      sel.addEventListener('change', async () => {
        const r2 = await api('PATCH', `/api/admin/users/${sel.dataset.id}/role`, { role: sel.value });
        if (r2.status === 200) {
          toast('角色已更新为 ' + sel.value);
        } else {
          toast(r2.json && r2.json.error || '更新失败', 'err');
          loadUsers();
        }
      });
    });
  }

  // ---------- 提交总览 ----------
  async function loadSubs() {
    const r = await api('GET', '/api/submissions');
    const box = document.getElementById('sub-list');
    if (r.status !== 200) {
      box.innerHTML = `<div class="empty">加载失败：${esc(r.json && r.json.error || '')}</div>`;
      return;
    }
    const rows = r.json;
    if (!rows.length) {
      box.innerHTML = '<div class="empty">还没有任何提交。</div>';
      return;
    }
    box.innerHTML = `
      <table class="table">
        <thead><tr>
          <th>#</th><th>题目</th><th>提交者</th><th>状态</th><th>判定</th><th>耗时 / 内存</th><th>时间</th>
        </tr></thead>
        <tbody>
          ${rows.map((s) => `
            <tr>
              <td class="mono"><a href="/submission.html?id=${s.id}">#${s.id}</a></td>
              <td>${esc(s.problemTitle)}</td>
              <td class="mono">${esc(s.username)}</td>
              <td>${esc(statusText(s.status))}</td>
              <td>${verdictBadge(s.verdict)}</td>
              <td class="mono small">${s.timeMs != null ? esc(s.timeMs) + 'ms / ' + esc(s.memoryKb) + 'KB' : '—'}</td>
              <td class="mono small">${esc(fmtTime(s.createdAt))}</td>
            </tr>`).join('')}
        </tbody>
      </table>`;
  }

  // ---------- 绑定 ----------
  document.getElementById('new-problem').addEventListener('click', () => openForm(null));
  document.getElementById('tc-add').addEventListener('click', () => {
    document.getElementById('tc-rows').appendChild(ioRow({}));
  });
  document.getElementById('sample-add').addEventListener('click', () => {
    document.getElementById('sample-rows').appendChild(ioRow({}));
  });
  document.getElementById('form-save').addEventListener('click', saveProblem);
  document.getElementById('form-cancel').addEventListener('click', closeForm);
  document.getElementById('proto-form-btn').addEventListener('click', () => {
    fillFormFromJson(document.getElementById('f-protocol').value);
    setProtocolMode('form');
  });
  document.getElementById('proto-json-btn').addEventListener('click', () => {
    document.getElementById('f-protocol').value = buildJsonFromForm();
    setProtocolMode('json');
  });
  document.getElementById('proto-driver').addEventListener('change', () => {
    const isStations = document.getElementById('proto-driver').value === 'stations';
    document.getElementById('proto-twophase').classList.toggle('hidden', isStations);
    document.getElementById('proto-stations').classList.toggle('hidden', !isStations);
  });
  document.getElementById('new-contest').addEventListener('click', () => openContestForm(null));
  document.getElementById('ct-form-save').addEventListener('click', saveContest);
  document.getElementById('ct-form-cancel').addEventListener('click', closeContestForm);

  // 实时：提交变化时刷新总览（若在提交标签页）
  WOJ.openWs((msg) => {
    if (msg.type === 'submission' && !document.getElementById('tab-subs').classList.contains('hidden')) {
      loadSubs();
    }
  });

  loadProblems();
})();
