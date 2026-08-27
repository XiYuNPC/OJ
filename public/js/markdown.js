// markdown.js —— 零依赖 Markdown 渲染（题解用）
// 支持：标题 #/##/###、```lang 围栏代码块、行内代码 `、粗体 **、斜体 *、列表 -/1.、链接 [t](url)。
// 安全：所有内容先 HTML 转义再插标签；链接仅允许 http/https；代码块内容同样转义。
(function () {
  "use strict";

  function esc(s) {
    return String(s).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
  }

  // 行内格式：行内代码 → 粗体 → 斜体 → 链接（按此顺序，避免相互嵌套破坏）
  function inline(s) {
    s = esc(s);
    s = s.replace(/`([^`]+)`/g, (_m, c) => `<code>${c}</code>`);
    s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/\*([^*]+)\*/g, "<em>$1</em>");
    s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    return s;
  }

  // 行级状态机：围栏代码块 > 标题 > 列表 > 段落
  function renderMarkdown(src) {
    if (src == null) return "";
    const lines = String(src).replace(/\r\n/g, "\n").split("\n");
    const out = [];
    let para = [];
    let list = null; // { ordered, items: [[...lines]] }
    let code = null; // { buf: [], lang: "" }

    const flushPara = () => {
      if (para.length) { out.push(`<p>${para.map(inline).join("<br>")}</p>`); para = []; }
    };
    const flushList = () => {
      if (list) {
        const tag = list.ordered ? "ol" : "ul";
        out.push(`<${tag}>${list.items.map((li) => `<li>${li.map(inline).join("<br>")}</li>`).join("")}</${tag}>`);
        list = null;
      }
    };

    for (const raw of lines) {
      const line = raw.trimEnd();
      if (code) {
        if (/^```/.test(line)) {
          out.push(`<pre><code${code.lang ? ` class="lang-${esc(code.lang)}"` : ""}>${esc(code.buf.join("\n"))}</code></pre>`);
          code = null;
        } else {
          code.buf.push(line);
        }
        continue;
      }
      const trimmed = line.trim();
      if (/^```/.test(trimmed)) {
        flushPara(); flushList();
        code = { buf: [], lang: trimmed.slice(3).trim() };
        continue;
      }
      const mh = line.match(/^(#{1,3})\s+(.*)$/);
      if (mh) {
        flushPara(); flushList();
        out.push(`<h${mh[1].length + 2}>${inline(mh[2])}</h${mh[1].length + 2}>`);
        continue;
      }
      const ml = line.match(/^\s*([-*])\s+(.*)$/);
      if (ml) {
        flushPara();
        if (!list || list.ordered) list = { ordered: false, items: [] };
        list.items.push([ml[2]]);
        continue;
      }
      const mo = line.match(/^\s*\d+\.\s+(.*)$/);
      if (mo) {
        flushPara();
        if (!list || !list.ordered) list = { ordered: true, items: [] };
        list.items.push([mo[1]]);
        continue;
      }
      if (trimmed === "") { flushPara(); flushList(); continue; }
      flushList();
      para.push(line);
    }
    flushPara(); flushList();
    if (code) out.push(`<pre><code>${esc(code.buf.join("\n"))}</code></pre>`); // 未闭合代码块兜底
    return out.join("");
  }

  window.renderMarkdown = renderMarkdown;
})();
