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

  // ---------- 导航 ----------
  function renderNav(active) {
    const el = document.getElementById('nav');
    if (!el) return;
    const user = getUser();
    const links = [
      { href: '/', label: '题库', key: 'problems', roles: null },
      { href: '/submissions.html', label: '提交记录', key: 'submissions', roles: ['member', 'admin'] },
      { href: '/admin.html', label: '后台', key: 'admin', roles: ['admin'] },
    ];
    const linksHtml = links
      .filter((l) => !l.roles || (user && l.roles.includes(user.role)))
      .map(
        (l) =>
          `<a href="${l.href}" data-nav="${l.key}" class="${l.key === active ? 'active' : ''}">${l.label}</a>`
      )
      .join('') +
      '<a href="/api/docs" target="_blank" rel="noopener">接口文档</a>';

    let userHtml;
    if (!user) {
      userHtml = `<a class="sidebar-auth" href="/login.html${location.pathname.includes('problem') ? '?next=' + encodeURIComponent(location.pathname + location.search) : ''}">登录 / 注册</a>`;
    } else {
      const roleTag = user.role === 'admin' ? 'admin' : 'member';
      userHtml = `
        <div class="sidebar-who"><span class="who">${esc(user.username)}</span><span class="tag">${roleTag}</span></div>
        <a href="#" id="logout">退出</a>`;
    }
    el.innerHTML = `
      <aside class="sidebar">
        <div class="sidebar-head">
          <a class="logo" href="/">weboj<span class="logo-caret">$</span></a>
          <div class="sidebar-user">${userHtml}</div>
        </div>
        <nav class="sidebar-links">${linksHtml}</nav>
      </aside>`;
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
