// code-editor.js —— 轻量代码编辑增强（零依赖，Dev-C++ 风格按键体验）
// 挂到 textarea 上即可获得：Tab/Shift+Tab 缩进、Enter 自动缩进（含 { } 之间展开成三行）、
// } 智能回退一级缩进、括号/引号自动配对与成对删除、Ctrl+/ 行注释切换。
// 所有修改统一走 setRangeText + 派发 input 事件：与页面既有的草稿自动保存（监听 input）
// 兼容，且纳入浏览器原生 undo 历史；IME 组合输入时不触发任何拦截。
(function () {
  "use strict";

  const PAIRS = { "(": ")", "[": "]", "{": "}", '"': '"', "'": "'" };
  const CLOSERS = { ")": "(", "]": "[", "}": "{", '"': '"', "'": "'" };
  const INDENT = "    ";

  // ---------- C++ 语法高亮（零依赖，词法 tokenize） ----------
  const escHtml = (s) =>
    String(s).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

  const KEYWORDS = new Set(("alignas alignof and and_eq asm auto bitand bitor bool break case catch char char8_t char16_t char32_t class compl concept const consteval constexpr constinit const_cast continue co_await co_return co_yield decltype default delete do double dynamic_cast else enum explicit export extern false float for friend goto if inline int long mutable namespace new noexcept not not_eq nullptr operator or or_eq private protected public register reinterpret_cast requires return short signed sizeof static static_assert static_cast struct switch template this thread_local throw true try typedef typeid typename union unsigned using virtual void volatile wchar_t while xor xor_eq").split(" "));

  const TYPES = new Set(("string string_view vector map set unordered_map unordered_set multiset multimap deque list forward_list queue priority_queue stack pair tuple array optional variant bitset iostream istream ostream ifstream ofstream fstream stringstream sstream").split(" "));

  // 单个正则按优先级交替匹配：注释 / 字符串 / 预处理 / 数字 / 标识符
  const TOKEN_RE = /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*')|(^[ \t]*#[^\n]*)|(\b(?:0[xX][0-9a-fA-F]+|(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?[uUlLfF]*)\b)|(\b[A-Za-z_]\w*\b)/gm;

  function highlightCpp(src) {
    let out = "";
    let last = 0;
    let m;
    TOKEN_RE.lastIndex = 0;
    while ((m = TOKEN_RE.exec(src))) {
      out += escHtml(src.slice(last, m.index));
      const full = m[0];
      if (m[1] != null) {
        out += '<span class="tok-com">' + escHtml(full) + "</span>";
      } else if (m[2] != null) {
        out += '<span class="tok-str">' + escHtml(full) + "</span>";
      } else if (m[3] != null) {
        const t = escHtml(full);
        out += '<span class="tok-pre">' + t.replace(/^([ \t]*#\s*)([A-Za-z_]\w*)/, '$1<span class="tok-pre-key">$2</span>') + "</span>";
      } else if (m[4] != null) {
        out += '<span class="tok-num">' + escHtml(full) + "</span>";
      } else if (m[5] != null) {
        const id = m[5];
        const next = src[m.index + full.length];
        if (KEYWORDS.has(id)) out += '<span class="tok-key">' + id + "</span>";
        else if (TYPES.has(id)) out += '<span class="tok-type">' + id + "</span>";
        else if (next === "(") out += '<span class="tok-fn">' + id + "</span>";
        else out += id;
      }
      last = m.index + full.length;
    }
    out += escHtml(src.slice(last));
    return out;
  }

  function setValue(el, start, end, text, selStart, selEnd) {
    el.setRangeText(text, start, end, "end");
    el.setSelectionRange(selStart, selEnd == null ? selStart : selEnd);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }

  // 选区覆盖的完整行块（无选区时即光标所在行）
  function lineBlock(v, s, t) {
    const start = v.lastIndexOf("\n", s - 1) + 1;
    let end = v.indexOf("\n", t);
    if (end === -1) end = v.length;
    return { start, end, text: v.slice(start, end) };
  }

  function indentBlock(el) {
    const v = el.value, s = el.selectionStart, t = el.selectionEnd;
    const b = lineBlock(v, s, t);
    const mapped = b.text.split("\n").map((ln) => (ln.length ? INDENT + ln : ln)).join("\n");
    setValue(el, b.start, b.end, mapped, b.start, b.start + mapped.length);
  }

  function outdentBlock(el) {
    const v = el.value, s = el.selectionStart, t = el.selectionEnd;
    const b = lineBlock(v, s, t);
    const mapped = b.text.split("\n").map((ln) => {
      let n = 0;
      while (n < INDENT.length && ln[n] === " ") n++;
      return ln.slice(n);
    }).join("\n");
    setValue(el, b.start, b.end, mapped, b.start, b.start + mapped.length);
  }

  function toggleComment(el) {
    const v = el.value, s = el.selectionStart, t = el.selectionEnd;
    const b = lineBlock(v, s, t);
    const lines = b.text.split("\n");
    const all = lines.every((ln) => !ln.trim() || ln.trimStart().startsWith("//"));
    const mapped = lines
      .map((ln) => {
        if (!ln.trim()) return ln;
        return all ? ln.replace(/^(\s*)\/\/ ?/, "$1") : ln.replace(/^(\s*)/, "$1// ");
      })
      .join("\n");
    setValue(el, b.start, b.end, mapped, b.start, b.start + mapped.length);
  }

  function install(el) {
    if (!el || el.tagName !== "TEXTAREA" || el.dataset.editor) return;
    el.dataset.editor = "1";

    // —— 语法高亮：透明 textarea 叠在着色 pre 之上（字体/内边距严格一致，滚动与尺寸同步） ——
    const wrap = document.createElement("div");
    wrap.className = "code-editor-wrap";
    const pre = document.createElement("pre");
    pre.className = "code-highlight";
    pre.setAttribute("aria-hidden", "true");
    el.parentNode.insertBefore(wrap, el);
    wrap.appendChild(pre);
    wrap.appendChild(el);

    const render = () => { pre.innerHTML = highlightCpp(el.value) + "\n"; };
    const syncScroll = () => { pre.scrollTop = el.scrollTop; pre.scrollLeft = el.scrollLeft; };
    const syncSize = () => {
      pre.style.width = el.clientWidth + "px";
      pre.style.height = el.clientHeight + "px";
    };
    render();
    syncSize();
    el.addEventListener("input", render);
    el.addEventListener("scroll", syncScroll);
    if (typeof ResizeObserver !== "undefined") {
      new ResizeObserver(syncSize).observe(el);
    }

    el.addEventListener("keydown", (e) => {
      const v = el.value, s = el.selectionStart, t = el.selectionEnd;
      const composing = e.isComposing || e.keyCode === 229;

      // Ctrl+/：行注释切换（选区覆盖的所有行整体加/去 //）
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key === "/") {
        e.preventDefault();
        if (!composing) toggleComment(el);
        return;
      }

      // Tab / Shift+Tab：无选区插入 4 空格 / 整块缩进；Shift 反缩进
      if (e.key === "Tab") {
        e.preventDefault();
        if (composing) return;
        if (e.shiftKey) outdentBlock(el);
        else if (s !== t) indentBlock(el);
        else setValue(el, s, t, INDENT, s + INDENT.length);
        return;
      }

      // Enter：继承上一行缩进；以 { 结尾再 +4 空格；
      // 光标位于自动配对的 { } 之间时展开成三行、光标落中间
      if (e.key === "Enter") {
        if (composing) return;
        e.preventDefault();
        const ls = v.lastIndexOf("\n", s - 1) + 1;
        let le = v.indexOf("\n", s);
        if (le === -1) le = v.length;
        const before = v.slice(ls, s);                          // 光标前本行内容
        const after = v.slice(s, le).replace(/^[ \t]*/, "");    // 光标后本行内容（去前导空白）
        const indent = (before.match(/^[ \t]*/) || [""])[0];
        if (before.endsWith("{") && after.startsWith("}")) {
          const ins = "\n" + indent + INDENT + "\n" + indent;
          setValue(el, s, t, ins, s + indent.length + INDENT.length + 1);
        } else {
          const extra = before.replace(/[ \t]+$/, "").endsWith("{") ? INDENT : "";
          const ins = "\n" + indent + extra;
          setValue(el, s, t, ins, s + ins.length);
        }
        return;
      }

      // }：当前行只剩空白时先回退一级缩进（与自动配对 + 回车展开配合）
      if (e.key === "}" && !composing && s === t) {
        const ls = v.lastIndexOf("\n", s - 1) + 1;
        const prefix = v.slice(ls, s);
        if (/^[ \t]*$/.test(prefix) && prefix.length) {
          e.preventDefault();
          const cut = Math.min(prefix.length, INDENT.length);
          setValue(el, s - cut, t, "}", s - cut + 1);
          return;
        }
      }

      // Backspace：光标位于自动配对符号之间时成对删除
      if (e.key === "Backspace" && !composing && s === t && s > 0) {
        if (PAIRS[v[s - 1]] === v[s]) {
          e.preventDefault();
          setValue(el, s - 1, s + 1, "", s - 1);
          return;
        }
      }

      // 输入左半：自动补右半、光标居中；有选区时用括号包裹选区
      const close = PAIRS[e.key];
      if (close && !composing && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        if (s !== t) setValue(el, s, t, e.key + v.slice(s, t) + close, s + 1, t + 1);
        else setValue(el, s, t, e.key + close, s + 1);
        return;
      }

      // 输入右半：紧邻同字符时跳过（不重复插入）
      if (CLOSERS[e.key] && !composing && s === t && v[s] === e.key) {
        e.preventDefault();
        el.setSelectionRange(s + 1, s + 1);
        return;
      }
    });
  }

  window.installCodeEditor = install;
  window.highlightCpp = highlightCpp;   // 供提交详情页等静态展示源代码时复用着色
})();
