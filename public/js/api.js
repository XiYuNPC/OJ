// WebOJ 前端共享工具：会话存储、API 封装、导航渲染、toast、WebSocket
(function () {
  const TOKEN_KEY = 'weboj_token';
  const USER_KEY = 'weboj_user';

  // ---------- 会话 ----------
  function getToken() {
    return localStorage.getItem(TOKEN_KEY) || null;
  }
  function getUser() {
    try {
      return JSON.parse(localStorage.getItem(USER_KEY)) || null;
    } catch (e) {
      return null;
    }
  }
  function setSession(data) {
    localStorage.setItem(TOKEN_KEY, data.token);
    localStorage.setItem(USER_KEY, JSON.stringify(data.user));
  }
  function clearSession() {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
  }

  // ---------- API ----------
  async function api(method, path, body) {
    const headers = {};
    const token = getToken();
    if (token) headers.Authorization = 'Bearer ' + token;
    const payload = body === undefined ? null : JSON.stringify(body);
    if (payload !== null) headers['Content-Type'] = 'application/json';
    let res;
    try {
      res = await fetch(path, { method, headers, body: payload });
    } catch (e) {
      return { status: 0, json: { error: '网络请求失败' } };
    }
    let json = null;
    try {
      json = await res.json();
    } catch (e) {}
    return { status: res.status, json };
  }

  // ---------- 工具 ----------
  function esc(s) {
    return String(s == null ? '' : s)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;');
  }
  function qs(name) {
    return new URLSearchParams(location.search).get(name);
  }
  function fmtTime(s) {
    if (!s) return '—';
    const d = new Date(s.replace(' ', 'T') + 'Z');
    return isNaN(d) ? s : d.toLocaleString('zh-CN', { hour12: false });
  }
  const STATUS_TEXT = { pending: '等待中', judging: '评测中', done: '完成' };
  function statusText(s) {
    return STATUS_TEXT[s] || s;
  }
  function verdictBadge(v) {
    return v
      ? `<span class="verdict verdict-${esc(v)}">${esc(v)}</span>`
      : '<span class="verdict verdict-none">—</span>';
  }
  function statusDot(status) {
    const cls = status === 'judging' ? 'dot dot-judging' : status === 'done' ? 'dot dot-done' : 'dot';
    return `<span class="${cls}"></span><span class="status-text">${esc(statusText(status))}</span>`;
  }

  // ---------- toast ----------
  function toast(msg, kind) {
    let box = document.getElementById('toasts');
    if (!box) {
      box = document.createElement('div');
      box.id = 'toasts';
      document.body.appendChild(box);
    }
    const el = document.createElement('div');
    el.className = 'toast' + (kind === 'err' ? ' toast-err' : '');
    el.textContent = msg;
    box.appendChild(el);
    setTimeout(() => el.remove(), 3600);
  }

  // ---------- 导航（默认收起为窄栏，hover 自动展开；图标 + 文字分离，折叠文字统一 .sb-txt） ----------
  function renderNav(active) {
    const el = document.getElementById('nav');
    if (!el) return;
    const user = getUser();
    const links = [
      { href: '/', label: '题库', key: 'problems', ico: 'P', roles: null },
      { href: '/contests.html', label: '比赛', key: 'contests', ico: 'C', roles: null },
      { href: '/submissions.html', label: '提交记录', key: 'submissions', ico: 'S', roles: ['member', 'admin'] },
      { href: '/admin.html', label: '后台', key: 'admin', ico: 'A', roles: ['admin'] },
    ];
    const linksHtml = links
      .filter((l) => !l.roles || (user && l.roles.includes(user.role)))
      .map(
        (l) =>
          `<a href="${l.href}" data-nav="${l.key}" class="${l.key === active ? 'active' : ''}"><span class="nav-ico">${l.ico}</span><span class="sb-txt">${l.label}</span></a>`
      )
      .join('') +
      '<a href="/api/docs" target="_blank" rel="noopener"><span class="nav-ico">D</span><span class="sb-txt">接口文档</span></a>';

    let userHtml;
    if (!user) {
      userHtml = `<a class="sidebar-auth" href="/login.html${location.pathname.includes('problem') ? '?next=' + encodeURIComponent(location.pathname + location.search) : ''}"><span class="nav-ico">登</span><span class="sb-txt">登录 / 注册</span></a>`;
    } else {
      const roleTag = user.role === 'admin' ? 'admin' : 'member';
      userHtml = `
        <span class="u-avatar">${esc(user.username.slice(0, 1).toUpperCase())}</span>
        <span class="u-body sb-txt">
          <span class="sidebar-who"><a class="who" href="/user.html?username=${encodeURIComponent(user.username)}">${esc(user.username)}</a><span class="tag">${roleTag}</span></span>
          <a href="#" id="logout">退出</a>
        </span>`;
    }
    // 展开判定：手动固定（toggle）或点击链接后的「临时展开」均保持弹出
    const pinned = localStorage.getItem('weboj_sidebar_pinned') === '1' ||
                   localStorage.getItem('weboj_sidebar_peek') === '1';
    el.innerHTML = `
      <aside class="sidebar${pinned ? ' pinned' : ''}">
        <div class="sidebar-head">
          <a class="logo" href="/"><span class="logo-mark">$</span><span class="logo-text sb-txt">weboj</span></a>
          <div class="sidebar-user">${userHtml}</div>
        </div>
        <nav class="sidebar-links">${linksHtml}</nav>
        <button class="sidebar-toggle" id="sidebar-toggle" type="button" title="固定展开 / 自动折叠">
          <span class="toggle-expand">»</span>
          <span class="toggle-collapse">«</span>
          <span class="sb-txt toggle-txt-expand">固定</span>
          <span class="sb-txt toggle-txt-collapse">收起</span>
        </button>
      </aside>`;
    const sb = el.querySelector('.sidebar');
    const toggle = document.getElementById('sidebar-toggle');
    if (toggle) {
      toggle.addEventListener('click', () => {
        const now = !sb.classList.contains('pinned');
        sb.classList.toggle('pinned', now);
        localStorage.setItem('weboj_sidebar_pinned', now ? '1' : '0');
        localStorage.removeItem('weboj_sidebar_peek'); // 手动固定/收起时清除临时展开态
      });
    }
    // 点击侧栏任意链接：立即钉住展开（避免跳转瞬间 hover 失效导致「先缩回」），
    // 并写入 peek 标记，供跳转后的新页面保持弹出
    sb.addEventListener('click', (e) => {
      if (e.target.closest('a')) {
        localStorage.setItem('weboj_sidebar_peek', '1');
        sb.classList.add('pinned');
      }
    });
    // 光标移出侧栏：延迟缩回（给页面跳转留窗口，避免旧页面误清 peek）。
    // 跳转后旧页面的 setTimeout 随页面卸载被取消，peek 得以保留到新页面读取。
    let leaveTimer = null;
    sb.addEventListener('mouseleave', () => {
      if (localStorage.getItem('weboj_sidebar_pinned') === '1') return; // 手动固定态不受影响
      clearTimeout(leaveTimer);
      leaveTimer = setTimeout(() => {
        if (localStorage.getItem('weboj_sidebar_pinned') === '1') return;
        localStorage.removeItem('weboj_sidebar_peek');
        sb.classList.remove('pinned');
      }, 250);
    });
    const logout = document.getElementById('logout');
    if (logout) {
      logout.addEventListener('click', (e) => {
        e.preventDefault();
        clearSession();
        location.href = '/';
      });
    }
  }

  // ---------- WebSocket ----------
  // 返回 ws 实例或 null（未登录）；onMessage 收到 {type:'submission', ...}
  function openWs(onMessage) {
    const token = getToken();
    if (!token) return null;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    let ws;
    try {
      ws = new WebSocket(`${proto}://${location.host}/ws?token=${encodeURIComponent(token)}`);
    } catch (e) {
      return null;
    }
    ws.onmessage = (e) => {
      try {
        onMessage(JSON.parse(e.data));
      } catch (err) {}
    };
    return ws;
  }

  window.WOJ = {
    getToken,
    getUser,
    setSession,
    clearSession,
    api,
    esc,
    qs,
    fmtTime,
    statusText,
    verdictBadge,
    statusDot,
    toast,
    renderNav,
    openWs,
  };
})();
