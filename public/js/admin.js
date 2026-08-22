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
  const tabs = { problems: 'tab-problems', users: 'tab-users', subs: 'tab-subs' };
  document.querySelectorAll('.tab').forEach((t) => {
    t.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x === t));
      Object.entries(tabs).forEach(([key, sec]) => {
        document.getElementById(sec).classList.toggle('hidden', key !== t.dataset.tab);
      });
      if (t.dataset.tab === 'problems') loadProblems();
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
      isCommunication: document.getElementById('f-comm').checked,
      protocol: document.getElementById('f-protocol').value.trim() || null,
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

  // 实时：提交变化时刷新总览（若在提交标签页）
  WOJ.openWs((msg) => {
    if (msg.type === 'submission' && !document.getElementById('tab-subs').classList.contains('hidden')) {
      loadSubs();
    }
  });

  loadProblems();
})();
