// content.js —— DeepSeek 网页增强（纯原生底层增强：关闭虚拟滚动卸载 + 防抢滚 + 宽屏排版 + 思维链折叠 + LaTeX 兼容渲染与源码复制）
// 100% 保留原网页原生功能（图片/附件上传、分支切换、右侧导航、重新生成、深度思考、智能搜索）

(() => {
  if (window.__dsToolkitLoaded) return;
  window.__dsToolkitLoaded = true;

  // 先彻底清理旧版遗留的任何覆盖层 DOM
  for (const oldId of ["dsv-reader", "dsv-fab", "dsw-root", "dsw-entry-toggle"]) {
    const el = document.getElementById(oldId);
    if (el) el.remove();
  }
  document.body?.classList.remove("dsv-reader-open");
  document.documentElement?.classList.remove("dsw-active");

  const DEFAULTS = {
    staticRender: true,        // 原生关闭虚拟滚动（全量静态 DOM 常驻，不卸载、不闪烁、支持 Ctrl+F）
    scrollGuard: true,         // 流式生成时防强制吸底抢滚
    pageWidth: "wide",         // 对话区宽度: "standard" (800px) | "wide" (980px) | "ultrawide" (1180px)
    showTopBar: true,          // 显示右上角轻量增强胶囊
    collapseDefault: true,     // 历史思维链默认收起
    autoCollapseOnDone: true,  // 生成完成自动收起思维链
    rememberState: true,       // 记住每条思维链的展开状态
    latexConvert: true,        // 把 \[...\] / \(...\) 转成公式渲染
    latexCopy: true,           // 复制公式时输出完整 LaTeX
    copyWithDelimiters: true   // 复制时带上 $ / $$ 定界符
  };

  const WIDTH_MAP = {
    standard: "800px",
    wide: "980px",
    ultrawide: "1180px"
  };

  const WIDTH_LABELS = {
    standard: "标准 800",
    wide: "宽屏 980",
    ultrawide: "超宽 1180"
  };

  let settings = { ...DEFAULTS };
  let storedThinkState = {};
  let userTouched = new WeakSet();
  let wasGenerating = new WeakSet();
  const clickLock = new WeakMap();
  let syntheticClick = false;
  let lastScrollAt = 0;
  let scrollIdleTimer = 0;
  let pillEl = null;

  const HAVE_KATEX = typeof katex !== "undefined" && katex && typeof katex.renderToString === "function";

  const BLOCK_TAGS = new Set([
    "ADDRESS", "ARTICLE", "ASIDE", "BLOCKQUOTE", "DIV", "DL", "FIELDSET", "FIGCAPTION",
    "FIGURE", "FOOTER", "FORM", "H1", "H2", "H3", "H4", "H5", "H6", "HEADER", "HR",
    "LI", "MAIN", "NAV", "OL", "P", "PRE", "SECTION", "TABLE", "TR", "UL"
  ]);

  /* ------------------------------------------------------------------ */
  /* 设置与初始化                                                         */
  /* ------------------------------------------------------------------ */

  chrome.storage.local.get(["dsToolkitSettings", "dsToolkitThinkState"], (res) => {
    settings = { ...DEFAULTS, ...(res?.dsToolkitSettings || {}) };
    storedThinkState = (res?.dsToolkitThinkState || {}) || {};
    queueMicrotask(boot);
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.dsToolkitSettings) {
      settings = { ...DEFAULTS, ...(changes.dsToolkitSettings.newValue || {}) };
      applyAllEnhancements();
      scheduleScan(0);
      scheduleThink(0);
    }
    if (changes.dsToolkitThinkState) {
      storedThinkState = changes.dsToolkitThinkState.newValue || {};
    }
  });

  function saveSettings() {
    try {
      chrome.storage.local.set({ dsToolkitSettings: settings });
    } catch {
      // ignore
    }
  }

  function saveThinkState() {
    if (!settings.rememberState) return;
    try {
      chrome.storage.local.set({ dsToolkitThinkState: storedThinkState });
    } catch {
      // ignore
    }
  }

  /* ------------------------------------------------------------------ */
  /* 核心 1：原生关闭虚拟滚动（全量静态 DOM 渲染） + 宽屏排版                */
  /* ------------------------------------------------------------------ */

  function isVirtualListActive() {
    const items = document.querySelector(".ds-virtual-list-items");
    const vis = document.querySelector(".ds-virtual-list-visible-items");
    if (!items || !vis) return false;
    // 当 DeepSeek 处于 virtual=true 时，items 会被设上 style.minHeight 或 style.height，
    // 或者 vis 的 transform 不是 translateY(0px)
    if (items.style.minHeight || items.style.height) return true;
    const tf = vis.style.transform || "";
    if (tf && tf !== "translateY(0px)" && tf !== "none") return true;
    return false;
  }

  let lastDisableVirtualAt = 0;

  function ensureStaticVirtualList({ force = false } = {}) {
    if (!settings.staticRender) return false;
    const vl = document.querySelector(".ds-virtual-list");
    if (!vl) return false;
    const now = Date.now();
    if (!force && now - lastDisableVirtualAt < 180) return false;
    if (!force && !isVirtualListActive()) return false;

    lastDisableVirtualAt = now;
    const prevTop = vl.scrollTop;
    const prevHeight = vl.scrollHeight;
    const wasBottom = prevHeight - prevTop - vl.clientHeight <= 90;

    // 通知 main-world 放行并触发 React 原生 beforeprint 钩子 (G.current = false; flushSync(q))
    window.dispatchEvent(new CustomEvent("dsv:disable-virtual"));
    window.dispatchEvent(new Event("beforeprint"));

    // 保持滚动条位置稳定
    if (wasBottom) {
      vl.scrollTop = vl.scrollHeight;
    } else if (prevTop > 0 && vl.scrollHeight !== prevHeight) {
      vl.scrollTop = prevTop;
    }
    updateTopPillStatus();
    return true;
  }

  function applyPageWidthAndConfig() {
    const w = WIDTH_MAP[settings.pageWidth] || WIDTH_MAP.wide;
    document.documentElement.style.setProperty("--dsv-message-max-width", w);
    document.documentElement.setAttribute("data-dsv-width", settings.pageWidth || "wide");
    document.documentElement.toggleAttribute("data-dsv-static", Boolean(settings.staticRender));

    window.dispatchEvent(
      new CustomEvent("dsv:config", {
        detail: {
          scrollGuard: Boolean(settings.scrollGuard),
          staticRender: Boolean(settings.staticRender)
        }
      })
    );
  }

  function applyAllEnhancements() {
    applyPageWidthAndConfig();
    if (settings.staticRender) {
      ensureStaticVirtualList({ force: true });
    }
    ensureTopPill();
    updateTopPillStatus();
  }

  /* ------------------------------------------------------------------ */
  /* 核心 2：右上角轻量原生胶囊控件（不遮挡任何原生区域）                    */
  /* ------------------------------------------------------------------ */

  function ensureTopPill() {
    if (!settings.showTopBar) {
      if (pillEl) {
        pillEl.remove();
        pillEl = null;
      }
      return;
    }
    if (!pillEl || !document.body.contains(pillEl)) {
      pillEl = document.createElement("div");
      pillEl.id = "dsv-top-pill";
      pillEl.innerHTML = `
        <span class="dsv-pill-badge" data-role="status" title="当前会话所有消息已全量挂载到 DOM，零闪烁、不卸载，可直接 Ctrl+F 搜索全文">
          <span class="dsv-pill-dot"></span>
          <span data-role="status-text">全量渲染</span>
        </span>
        <span class="dsv-pill-sep"></span>
        <button type="button" class="dsv-pill-btn" data-act="cycle-width" title="切换对话排版宽度（标准 800px / 宽屏 980px / 超宽 1180px）">宽屏 980</button>
        <button type="button" class="dsv-pill-btn" data-act="toggle-all-think" title="一键折叠或展开当前页所有深度思考过程">收起思考</button>
      `;
      pillEl.addEventListener("click", (e) => {
        const btn = e.target.closest("[data-act]");
        if (!btn) return;
        const act = btn.dataset.act;
        if (act === "cycle-width") {
          const order = ["standard", "wide", "ultrawide"];
          const idx = order.indexOf(settings.pageWidth);
          settings.pageWidth = order[(idx + 1) % order.length];
          saveSettings();
          applyPageWidthAndConfig();
          updateTopPillStatus();
        } else if (act === "toggle-all-think") {
          const blocks = thinkBlocks();
          const anyOpen = blocks.some((b) => isOpenBlock(b.container));
          setAllThink(!anyOpen);
          updateTopPillStatus();
        }
      });
      document.body.appendChild(pillEl);
      updateTopPillStatus();
    }
  }

  function updateTopPillStatus() {
    if (!pillEl) return;
    // 在登录页自动隐藏胶囊
    if (location.pathname.startsWith("/sign_in")) {
      pillEl.style.display = "none";
      return;
    }
    pillEl.style.display = "inline-flex";

    const count = document.querySelectorAll(".ds-virtual-list-visible-items > div, [data-virtual-list-item-key]").length;
    const statusText = pillEl.querySelector('[data-role="status-text"]');
    const badge = pillEl.querySelector('[data-role="status"]');
    if (statusText) {
      const nextStatus = settings.staticRender
        ? (count > 0 ? `全量渲染 · ${count}条` : "全量渲染")
        : "原生虚拟列表";
      if (statusText.textContent !== nextStatus) {
        statusText.textContent = nextStatus;
      }
      if (settings.staticRender) {
        if (!badge?.classList.contains("is-on")) badge?.classList.add("is-on");
      } else {
        if (badge?.classList.contains("is-on")) badge?.classList.remove("is-on");
      }
    }

    const widthBtn = pillEl.querySelector('[data-act="cycle-width"]');
    if (widthBtn) {
      const nextWidthText = WIDTH_LABELS[settings.pageWidth] || WIDTH_LABELS.wide;
      if (widthBtn.textContent !== nextWidthText) {
        widthBtn.textContent = nextWidthText;
      }
    }

    const thinkBtn = pillEl.querySelector('[data-act="toggle-all-think"]');
    if (thinkBtn) {
      const blocks = thinkBlocks();
      if (!blocks.length) {
        if (thinkBtn.style.display !== "none") thinkBtn.style.display = "none";
      } else {
        if (thinkBtn.style.display !== "inline-flex") thinkBtn.style.display = "inline-flex";
        const anyOpen = blocks.some((b) => isOpenBlock(b.container));
        const nextThinkText = anyOpen ? `收起思考 (${blocks.length})` : `展开思考 (${blocks.length})`;
        if (thinkBtn.textContent !== nextThinkText) {
          thinkBtn.textContent = nextThinkText;
        }
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /* 核心 3：思维链折叠与状态记忆                                           */
  /* ------------------------------------------------------------------ */

  const CONTAINER_SELECTOR = 'div[style*="--collapsible-area-title-height"]';

  function blockTitle(header) {
    const raw = typeof header.innerText === "string" ? header.innerText : header.textContent || "";
    let t = raw.replace(/\s+/g, " ").trim();
    const half = t.length / 2;
    if (Number.isInteger(half) && half > 1 && t.slice(0, half) === t.slice(half)) {
      t = t.slice(0, half);
    }
    return t;
  }

  function isThinkTitle(title) {
    return /思考|Thinking|Thought for|已停止|Stopped/.test(title);
  }

  function isGeneratingTitle(title) {
    if (/用时|Thought for|已停止|Stopped/.test(title)) return false;
    return /正在思考|思考中|深度思考|Thinking|搜索中|Searching|浏览中/.test(title);
  }

  function isFinishedTitle(title) {
    return /用时|Thought for|已停止|Stopped/.test(title);
  }

  function thinkBlocks() {
    const out = [];
    const containers = document.querySelectorAll(CONTAINER_SELECTOR);
    for (const container of containers) {
      const header = container.firstElementChild;
      if (!header) continue;
      const title = blockTitle(header);
      if (!isThinkTitle(title)) continue;
      out.push({ container, header, title, key: blockKey(container, title) });
    }
    return out;
  }

  function hasThinkContent(container) {
    return Boolean(container.querySelector(".ds-think-content"));
  }

  function isCollapsedBlock(container) {
    return container.hasAttribute("data-dsv-collapsed") || !hasThinkContent(container);
  }

  function isOpenBlock(container) {
    return !isCollapsedBlock(container);
  }

  const syntheticIds = new WeakMap();
  let syntheticSeq = 0;

  function containerId(container) {
    const item = container.closest("[data-virtual-list-item-key]");
    const attr = item && item.getAttribute("data-virtual-list-item-key");
    if (attr) return `m${attr}`;
    // 在 virtual=false 下，根据它在 .ds-virtual-list-visible-items 中的顺序编号
    const vis = container.closest(".ds-virtual-list-visible-items");
    if (vis) {
      let topChild = container;
      while (topChild && topChild.parentElement !== vis) {
        topChild = topChild.parentElement;
      }
      if (topChild) {
        const idx = Array.prototype.indexOf.call(vis.children, topChild);
        if (idx >= 0) return `idx${idx}`;
      }
    }
    if (!syntheticIds.has(container)) syntheticIds.set(container, `s${syntheticSeq++}`);
    return syntheticIds.get(container);
  }

  function blockKey(container, title) {
    const session = location.pathname || "/";
    return `${session}|${containerId(container)}|${title.replace(/\s+/g, "")}`;
  }

  function rememberBlock(key, open) {
    if (!settings.rememberState) return;
    storedThinkState[key] = open ? "open" : "closed";
    const keys = Object.keys(storedThinkState);
    if (keys.length > 400) {
      for (const k of keys.slice(0, keys.length - 400)) delete storedThinkState[k];
    }
    saveThinkState();
  }

  function setBlockOpen(block, wantOpen, { record = false } = {}) {
    const collapsed = isCollapsedBlock(block.container);
    if (wantOpen === !collapsed) return false;
    const last = clickLock.get(block.container) || 0;
    if (Date.now() - last < 120) return false;
    clickLock.set(block.container, Date.now());

    if (!wantOpen) {
      if (hasThinkContent(block.container)) {
        block.container.setAttribute("data-dsv-collapsed", "1");
      }
    } else if (block.container.hasAttribute("data-dsv-collapsed")) {
      block.container.removeAttribute("data-dsv-collapsed");
    } else {
      syntheticClick = true;
      try {
        block.header.click();
      } catch {
        // ignore
      }
      syntheticClick = false;
    }

    if (record) rememberBlock(block.key, wantOpen);
    return true;
  }

  function isScrolling() {
    return Date.now() - lastScrollAt < 320;
  }

  function onScrollActivity() {
    lastScrollAt = Date.now();
    clearTimeout(scrollIdleTimer);
    scrollIdleTimer = setTimeout(() => {
      syncThink();
      scheduleScan(0);
    }, 360);
  }

  window.addEventListener("scroll", onScrollActivity, true);
  window.addEventListener("wheel", onScrollActivity, { passive: true, capture: true });
  window.addEventListener("touchmove", onScrollActivity, { passive: true, capture: true });

  let thinkQueued = false;
  function scheduleThink() {
    if (thinkQueued) return;
    thinkQueued = true;
    queueMicrotask(() => {
      thinkQueued = false;
      syncThink();
    });
  }

  function syncThink() {
    if (!settings.collapseDefault && !settings.autoCollapseOnDone && !settings.rememberState) return;
    if (isScrolling()) return;

    const blocks = thinkBlocks();
    if (!blocks.length) {
      updateTopPillStatus();
      return;
    }

    for (const block of blocks) {
      const generating = isGeneratingTitle(block.title);
      if (generating) {
        wasGenerating.add(block.container);
        continue;
      }
      if (!isFinishedTitle(block.title)) continue;
      if (userTouched.has(block.container)) continue;

      const open = isOpenBlock(block.container);
      const stored = settings.rememberState ? storedThinkState[block.key] : undefined;

      if (stored === "open") {
        if (!open) setBlockOpen(block, true);
        continue;
      }
      if (stored === "closed") {
        if (open) setBlockOpen(block, false);
        continue;
      }

      const seenGenerating = wasGenerating.has(block.container);
      const shouldCollapse =
        (settings.collapseDefault && !seenGenerating) ||
        (settings.autoCollapseOnDone && seenGenerating);
      if (shouldCollapse && open) {
        setBlockOpen(block, false);
      }
    }
    updateTopPillStatus();
  }

  function setAllThink(open) {
    const blocks = thinkBlocks();
    for (const block of blocks) {
      userTouched.add(block.container);
      if (isOpenBlock(block.container) !== open) {
        setBlockOpen(block, open);
      }
      rememberBlock(block.key, open);
    }
    updateTopPillStatus();
    return blocks.length;
  }

  document.addEventListener(
    "click",
    (e) => {
      if (syntheticClick || !e.isTrusted) return;
      const container = e.target?.closest?.(CONTAINER_SELECTOR);
      if (!container) return;
      const header = container.firstElementChild;
      if (!header || !e.target.closest || !header.contains(e.target)) return;
      const title = blockTitle(header);
      if (!isThinkTitle(title)) return;

      userTouched.add(container);

      if (container.hasAttribute("data-dsv-collapsed") && hasThinkContent(container)) {
        container.removeAttribute("data-dsv-collapsed");
        e.preventDefault();
        e.stopPropagation();
        rememberBlock(blockKey(container, title), true);
        updateTopPillStatus();
        return;
      }

      setTimeout(() => {
        const open = isOpenBlock(container);
        rememberBlock(blockKey(container, blockTitle(header) || title), open);
        updateTopPillStatus();
      }, 120);
    },
    true
  );

  /* ------------------------------------------------------------------ */
  /* 核心 4：LaTeX \[...\] / \(...\) 兼容渲染与选中公式复制源码             */
  /* ------------------------------------------------------------------ */

  function locate(nodes, index) {
    for (const seg of nodes) {
      if (index >= seg.start && index < seg.end) {
        if (!seg.node) return null;
        return { node: seg.node, offset: seg.base + (index - seg.start) };
      }
    }
    if (nodes.length) {
      const last = nodes[nodes.length - 1];
      if (index === last.end && last.node) {
        return { node: last.node, offset: last.base + (index - last.start) };
      }
    }
    return null;
  }

  function buildTextMap(block) {
    const nodes = [];
    let text = "";
    const SKIP = new Set(["PRE", "CODE", "SVG", "IMG", "TEXTAREA", "INPUT", "SCRIPT", "STYLE"]);

    function push(node, str, base = 0) {
      nodes.push({ node, start: text.length, end: text.length + str.length, base });
      text += str;
    }

    function walk(node) {
      if (node.nodeType === 3) {
        push(node, node.data);
        return;
      }
      if (node.nodeType !== 1) return;
      if (node.tagName === "BR") {
        push(null, "\n");
        return;
      }
      if (SKIP.has(node.tagName)) {
        push(null, "\u0000");
        return;
      }
      if (
        node.classList &&
        (node.classList.contains("katex") ||
          node.classList.contains("dsv-math") ||
          node.classList.contains("ds-markdown-cite") ||
          node.hasAttribute("data-dsv-hidden"))
      ) {
        push(null, "\u0000");
        return;
      }
      for (const child of node.childNodes) walk(child);
    }
    walk(block);
    return { text, nodes };
  }

  function looksLikeMath(inner, isParen) {
    if (!inner) return false;
    if (inner.length > 800) return false;
    if (inner.includes("\u0000")) return false;
    if (/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(inner)) return false;
    if (/^https?:/i.test(inner.trim())) return false;
    if (/citation:|reference:/i.test(inner)) return false;
    const hasCommand = /\\[a-zA-Z]{2,}/.test(inner);
    const mathChars = (inner.match(/[\\^_{}=<>+\-*/|]/g) || []).length;
    if (isParen) return hasCommand;
    return hasCommand || /[\^_]/.test(inner) || mathChars >= 2;
  }

  function buildMathNode(tex, display) {
    if (!HAVE_KATEX) return null;
    let html = "";
    try {
      html = katex.renderToString(tex, {
        displayMode: display,
        throwOnError: false,
        strict: false,
        output: "htmlAndMathml",
        trust: false
      });
    } catch {
      return null;
    }
    if (!html || html.indexOf("katex-error") !== -1) return null;
    const el = document.createElement(display ? "div" : "span");
    el.className = display ? "dsv-math dsv-math-display" : "dsv-math dsv-math-inline";
    el.setAttribute("data-dsv-tex", tex);
    el.setAttribute("data-dsv-display", display ? "1" : "0");
    el.setAttribute("title", "选中即可复制完整 LaTeX 源码");
    el.innerHTML = html;
    return el;
  }

  function findMatches(text) {
    const found = [];
    const patterns = [
      { re: /\\\[([\s\S]{2,800}?)\\\]/g, paren: false },
      { re: /\\\(([\s\S]{2,400}?)\\\)/g, paren: true },
      { re: /\[([^\[\]]{2,800})\]/g, paren: false },
      { re: /\(([^()]{2,400})\)/g, paren: true }
    ];
    for (const { re, paren } of patterns) {
      let m;
      while ((m = re.exec(text))) {
        const inner = m[1];
        if (!looksLikeMath(inner, paren)) continue;
        found.push({ start: m.index, end: m.index + m[0].length, inner });
      }
    }
    found.sort((a, b) => a.start - b.start || b.end - a.end);
    const out = [];
    let lastEnd = -1;
    for (const item of found) {
      if (item.start < lastEnd) continue;
      out.push(item);
      lastEnd = item.end;
    }
    return out;
  }

  // 修复被 DeepSeek 的 Markdown 解析器吞掉反斜杠的矩阵换行符 \\ 与分块矩阵小空格 \,
  function repairEscapedLatex(tex) {
    let t = tex;
    // 1. 在 \begin{matrix|pmatrix|bmatrix|Bmatrix|vmatrix|Vmatrix|cases|aligned|array} ... \end{...} 中，
    //    Markdown 把换行 \\ 转义成了单个 \ 加空格（如 "\ 0 & s-1" 或 "\ \alpha_2"），还原为 "\\ "
    t = t.replace(
      /(\\begin\{(?:[pbBvV]?matrix|cases|aligned|array|smallmatrix)\})([\s\S]*?)(\\end\{(?:[pbBvV]?matrix|cases|aligned|array|smallmatrix)\})/g,
      (_m, begin, body, end) => {
        const fixedBody = body.replace(/\\(\s+)/g, "\\\\$1");
        return begin + fixedBody + end;
      }
    );
    // 2. 修复分块矩阵里被吃掉反斜杠的 [, \lambda ... B ,] -> [\, \lambda ... B \,]
    t = t.replace(/\[,\s*(?=\\[a-zA-Z]+|[A-Za-z0-9])/g, "[\\,");
    t = t.replace(/,\](?=\s*[=<>+\-*/]|$)/g, "\\,]");
    return t;
  }

  function cleanBareTex(text) {
    let t = text.trim();
    t = t.replace(/^\\?\[\s*\n+/, "");
    t = t.replace(/\n+\s*\\?\]\]?$/, "");
    t = t.replace(/^\\?\[\s+/, "");
    t = t.replace(/\s+\\?\]\]?$/, "");
    return repairEscapedLatex(t.trim());
  }

  function looksLikeProse(text) {
    let t = text;
    for (let i = 0; i < 2; i++) t = t.replace(/\{[^{}]*\}/g, " ");
    t = t.replace(/\\[a-zA-Z]+/g, " ");
    return /[A-Za-z]{3,}/.test(t);
  }

  function looksLikeBareTex(text) {
    const t = cleanBareTex(text);
    if (!t || t.length > 2000) return false;
    if (/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(t)) return false;
    if (/^https?:/i.test(t)) return false;
    if (!/\\[a-zA-Z]{2,}/.test(t) && !/\^\{|_\{/.test(t) && !/[A-Za-z0-9_]+\([szt]\)\s*=/.test(t)) return false;
    if (!/[=<>]/.test(t) && !/\\(frac|sqrt|sum|int|partial|begin|implies|Rightarrow|to|cdot|times|le|ge|neq|approx|alpha|beta|gamma|lambda|Phi)\b/.test(t)) {
      return false;
    }
    if (looksLikeProse(t)) return false;
    return true;
  }

  function hideGhostBrackets(block) {
    for (const el of [block.previousElementSibling, block.nextElementSibling]) {
      if (!el) continue;
      const t = (el.textContent || "").trim();
      if (t === "[" || t === "]" || t === "\\[" || t === "\\]") {
        el.style.display = "none";
      }
    }
  }

  // 修复列表项缩进导致 DeepSeek 把 \[...\] 的开头 \[ 吞掉、而在 DOM 里留下 "<span...>公式</span><br><span>]</span>" 的情况
  function rescueBrokenBracketNodes(block) {
    const children = Array.from(block.childNodes);
    if (children.length < 2) return false;
    let changed = false;

    for (let i = 0; i < children.length; i++) {
      const node = children[i];
      if (!node || !node.parentNode) continue;
      if (node.nodeType === 1 && node.hasAttribute && node.hasAttribute("data-dsv-hidden")) continue;
      const txt = (node.textContent || "").trim();
      if (txt !== "]" && txt !== "\\]") continue;

      // 往前跳过空白文本节点与 <br>
      let brIdx = i - 1;
      while (brIdx >= 0 && children[brIdx].nodeType === 3 && !(children[brIdx].textContent || "").trim()) {
        brIdx--;
      }
      const hasBr = brIdx >= 0 && children[brIdx].nodeType === 1 && children[brIdx].tagName === "BR";
      let formulaEndIdx = hasBr ? brIdx - 1 : i - 1;
      while (
        formulaEndIdx >= 0 &&
        children[formulaEndIdx].nodeType === 3 &&
        !(children[formulaEndIdx].textContent || "").trim()
      ) {
        formulaEndIdx--;
      }
      if (formulaEndIdx < 0) continue;

      // 往前收集属于这行公式的连续纯文本/span节点（遇到上一个 <br> 或已渲染的公式则停下）
      let formulaStartIdx = formulaEndIdx;
      while (formulaStartIdx > 0) {
        const prev = children[formulaStartIdx - 1];
        if (!prev) break;
        if (prev.nodeType === 1 && (prev.tagName === "BR" || prev.classList?.contains("dsv-math") || prev.classList?.contains("katex"))) {
          break;
        }
        // 如果前一个节点包含中文说明文字，也不并入公式
        if (/[\u4e00-\u9fff]/.test(prev.textContent || "")) break;
        formulaStartIdx--;
      }

      let rawFormula = "";
      for (let k = formulaStartIdx; k <= formulaEndIdx; k++) {
        rawFormula += children[k].textContent || "";
      }
      const cleaned = cleanBareTex(rawFormula);
      if (!cleaned || /[\u4e00-\u9fff]/.test(cleaned)) continue;
      if (!looksLikeBareTex(cleaned) && !looksLikeMath(cleaned, false)) continue;

      const mathNode = buildMathNode(cleaned, true);
      if (!mathNode) continue;

      // 插入渲染好的块级公式，并将原先破损的 React 节点原地隐藏（不调用 removeChild，保持 React Fiber 引用完整）
      block.insertBefore(mathNode, children[formulaStartIdx]);
      let removeEnd = i;
      if (
        removeEnd + 1 < children.length &&
        children[removeEnd + 1].nodeType === 1 &&
        children[removeEnd + 1].tagName === "BR"
      ) {
        removeEnd += 1;
      }
      for (let k = formulaStartIdx; k <= removeEnd; k++) {
        const target = children[k];
        if (!target || target.parentNode !== block) continue;
        if (target.nodeType === 1) {
          target.setAttribute("data-dsv-hidden", "1");
          target.style.display = "none";
        } else if (target.nodeType === 3) {
          target.nodeValue = "";
        }
      }
      changed = true;
    }
    return changed;
  }

  function scanBlock(block) {
    // 先处理「公式 + <br> + <span>]</span> + (<br> + 注释)」这种被 DeepSeek 列表缩进拆碎的块级公式
    rescueBrokenBracketNodes(block);

    const map = buildTextMap(block);
    if (!map.text) return;

    if (!block.querySelector("a") && !block.querySelector(".dsv-math, .katex") && looksLikeBareTex(map.text)) {
      const node = buildMathNode(cleanBareTex(map.text), true);
      if (node) {
        // 原地隐藏 React 原生子节点，不调用 replaceChildren 破坏 React DOM 树
        for (const child of Array.from(block.childNodes)) {
          if (child.nodeType === 1) {
            child.setAttribute("data-dsv-hidden", "1");
            child.style.display = "none";
          } else if (child.nodeType === 3) {
            child.nodeValue = "";
          }
        }
        block.appendChild(node);
        hideGhostBrackets(block);
        return;
      }
    }

    if (!/[\[(]/.test(map.text)) return;

    const matches = findMatches(map.text);
    if (!matches.length) return;

    for (let i = matches.length - 1; i >= 0; i--) {
      const match = matches[i];
      const startPos = locate(map.nodes, match.start);
      const endPos = locate(map.nodes, match.end);
      if (!startPos || !endPos) continue;

      const covered = map.text.slice(match.start, match.end);
      const display = !map.text.trim() || map.text.trim() === covered.trim();
      const tex = repairEscapedLatex(match.inner.trim());
      const node = buildMathNode(tex, display);
      if (!node) continue;

      try {
        const range = document.createRange();
        range.setStart(startPos.node, startPos.offset);
        range.setEnd(endPos.node, endPos.offset);
        range.deleteContents();
        range.insertNode(node);
      } catch {
        // ignore
      }
    }
  }

  function hasBlockChild(el) {
    for (const child of el.children) {
      if (/^(P|LI|TD|TH|DIV|UL|OL|TABLE|BLOCKQUOTE|PRE)$/.test(child.tagName)) return true;
    }
    return false;
  }

  const blockSignature = new WeakMap();

  function signatureOf(block) {
    let text = "";
    for (const child of block.childNodes) {
      if (child.nodeType === 1 && child.hasAttribute && child.hasAttribute("data-dsv-hidden")) continue;
      text += child.textContent || "";
    }
    let count = 0;
    for (let i = 0; i < text.length; i++) {
      const ch = text.charCodeAt(i);
      if (ch === 91 || ch === 40) count++;
    }
    return text.length + "|" + count + "|" + block.querySelectorAll(".dsv-math").length + "|" + text.slice(-40);
  }

  function scanMathIn(scope) {
    if (!settings.latexConvert || !HAVE_KATEX || !scope) return;
    const roots = [];
    if (scope.matches && scope.matches(".ds-markdown")) roots.push(scope);
    if (scope.querySelectorAll) {
      for (const r of scope.querySelectorAll(".ds-markdown")) roots.push(r);
    }
    for (const root of roots) {
      if (root.closest(".dsv-math")) continue;
      const blocks = root.querySelectorAll("p, li, td, th, h1, h2, h3, h4, h5, h6");
      for (const block of blocks) {
        if (block.closest("pre, code, .dsv-math, .md-code-block")) continue;
        if (hasBlockChild(block)) continue;
        if (!/[\[(]|\\[a-zA-Z]|[\^_{]|\]\s*$/.test(block.textContent || "")) continue;
        const sig = signatureOf(block);
        if (blockSignature.get(block) === sig) continue;
        scanBlock(block);
        blockSignature.set(block, signatureOf(block));
      }
    }
  }

  function scanMath() {
    if (!settings.latexConvert || !HAVE_KATEX) return;
    // 在 virtual=false 下，所有节点都是静态常驻的，无需心配滚动中高度重算导致虚拟列表跳动
    scanMathIn(document.body);
  }

  let scanScheduled = false;
  function scheduleScan(delay = 250) {
    if (scanScheduled) return;
    scanScheduled = true;
    setTimeout(() => {
      scanScheduled = false;
      scanMath();
    }, delay);
  }

  /* ------------------------------------------------------------------ */
  /* 复制：选中公式任意片段 -> 剪贴板得到完整 LaTeX                         */
  /* ------------------------------------------------------------------ */

  const TEX_ANNOTATION = 'annotation[encoding="application/x-tex"]';

  function texOf(el) {
    if (!el) return "";
    const own = el.getAttribute && el.getAttribute("data-dsv-tex");
    if (own) return own;
    const ann = el.querySelector ? el.querySelector(TEX_ANNOTATION) : null;
    if (ann) return ann.textContent || "";
    return "";
  }

  function isDisplayFormula(el) {
    if (el.getAttribute && el.getAttribute("data-dsv-display") === "1") return true;
    return Boolean(el.closest(".katex-display, .dsv-math-display, .ds-markdown-math-display"));
  }

  function formatTex(el, withDelims) {
    const tex = texOf(el).trim();
    if (!tex) return null;
    if (!withDelims) return tex;
    return isDisplayFormula(el) ? `$$\n${tex}\n$$` : `$${tex}$`;
  }

  function rangeHits(range, node) {
    if (!node) return false;
    try {
      if (range.intersectsNode(node)) return true;
    } catch {
      // ignore
    }
    const startContainer = range.startContainer;
    const endContainer = range.endContainer;
    if (node === startContainer || node === endContainer) return true;
    try {
      if (node.contains && (node.contains(startContainer) || node.contains(endContainer))) return true;
    } catch {
      // ignore
    }
    try {
      if (typeof range.comparePoint === "function" && range.comparePoint(node, 0) === 0) return true;
    } catch {
      // ignore
    }
    return false;
  }

  function formulasInRange(range) {
    const all = Array.from(document.querySelectorAll(".dsv-math, .katex"));
    const hit = all.filter((el) => rangeHits(range, el));
    return hit.filter((el) => !hit.some((other) => other !== el && other.contains(el)));
  }

  function textOfNodeInRange(node, range) {
    const data = node.data || "";
    const startNode = range.startContainer;
    const endNode = range.endContainer;
    if (startNode === node && endNode === node) {
      return data.slice(range.startOffset, range.endOffset);
    }
    let s = startNode === node ? range.startOffset : 0;
    let e = endNode === node ? range.endOffset : data.length;
    if (s < 0) s = 0;
    if (e > data.length) e = data.length;
    return data.slice(s, e);
  }

  function buildClipboardText(range, formulas) {
    const set = new Set(formulas);
    const inserted = new Set();
    const parts = [];

    function walk(node) {
      if (node.nodeType === 3) {
        if (rangeHits(range, node)) parts.push(textOfNodeInRange(node, range));
        return;
      }
      if (node.nodeType !== 1) return;
      if (node.hasAttribute && node.hasAttribute("data-dsv-hidden")) return;

      if (set.has(node)) {
        if (rangeHits(range, node) && !inserted.has(node)) {
          inserted.add(node);
          const formatted = formatTex(node, settings.copyWithDelimiters);
          parts.push(formatted === null ? node.textContent || "" : formatted);
        }
        return;
      }
      if (node.tagName === "BR") {
        parts.push("\n");
        return;
      }

      const block = BLOCK_TAGS.has(node.tagName);
      if (block) parts.push("\n");
      for (const child of node.childNodes) walk(child);
      if (block) parts.push("\n");
    }

    let root = range.commonAncestorContainer;
    if (root && root.nodeType === 3) root = root.parentElement;
    if (root && root.closest) {
      const formulaRoot = root.closest(".dsv-math") || root.closest(".katex");
      if (formulaRoot) root = formulaRoot;
    }
    if (root) walk(root);

    return parts
      .join("")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  document.addEventListener(
    "copy",
    (e) => {
      if (!settings.latexCopy) return;
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return;
      const range = sel.getRangeAt(0);
      const formulas = formulasInRange(range);
      if (!formulas.length) return;
      const text = buildClipboardText(range, formulas);
      if (!text) return;
      try {
        e.clipboardData.setData("text/plain", text);
        e.preventDefault();
      } catch {
        // ignore
      }
    },
    true
  );

  /* ------------------------------------------------------------------ */
  /* 观察与会话切换巡检                                                   */
  /* ------------------------------------------------------------------ */

  let lastPath = location.pathname;

  function applyInstantState(root) {
    if (!root || root.nodeType !== 1) return;
    const containers = [];
    if (root.matches && root.matches(CONTAINER_SELECTOR)) containers.push(root);
    if (root.querySelectorAll) {
      for (const el of root.querySelectorAll(CONTAINER_SELECTOR)) containers.push(el);
    }
    if (!containers.length) return;

    for (const container of containers) {
      const header = container.firstElementChild;
      if (!header) continue;
      const title = blockTitle(header);
      if (!isThinkTitle(title) || !isFinishedTitle(title)) continue;
      if (userTouched.has(container)) continue;

      const key = blockKey(container, title);
      const stored = settings.rememberState ? storedThinkState[key] : undefined;

      if (stored === "open") {
        if (!hasThinkContent(container)) {
          syntheticClick = true;
          try {
            header.click();
          } catch {
            // ignore
          }
          syntheticClick = false;
        }
        continue;
      }

      if (stored === "closed" || settings.collapseDefault) {
        if (hasThinkContent(container)) {
          container.setAttribute("data-dsv-collapsed", "1");
        }
      }
    }
  }

  const observer = new MutationObserver((mutations) => {
    let hasRelevantMutation = false;
    let hasElementAdded = false;
    for (const m of mutations) {
      if (pillEl && (m.target === pillEl || pillEl.contains(m.target))) continue;
      hasRelevantMutation = true;
      if (!m.addedNodes || !m.addedNodes.length) continue;
      for (const node of m.addedNodes) {
        if (node.nodeType === 1) {
          if (pillEl && (node === pillEl || pillEl.contains(node))) continue;
          hasElementAdded = true;
          applyInstantState(node);
        }
      }
    }
    if (!hasRelevantMutation) return;
    if (hasElementAdded && settings.staticRender && isVirtualListActive()) {
      ensureStaticVirtualList();
    }
    scheduleThink();
    scheduleScan(250);
  });

  function startObserver() {
    try {
      observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    } catch {
      // ignore
    }
  }

  setInterval(() => {
    if (location.pathname !== lastPath) {
      lastPath = location.pathname;
      userTouched = new WeakSet();
      wasGenerating = new WeakSet();
      if (settings.staticRender) {
        setTimeout(() => ensureStaticVirtualList({ force: true }), 80);
        setTimeout(() => ensureStaticVirtualList({ force: true }), 450);
      }
      scheduleThink();
      scheduleScan(200);
    }
    if (settings.staticRender && isVirtualListActive()) {
      ensureStaticVirtualList();
    }
    ensureTopPill();
    updateTopPillStatus();
  }, 600);

  function boot() {
    applyAllEnhancements();
    startObserver();
    syncThink();
    scanMath();
    requestAnimationFrame(() => {
      ensureStaticVirtualList({ force: true });
      syncThink();
      scanMath();
    });
    setTimeout(() => {
      ensureStaticVirtualList({ force: true });
      scanMath();
      syncThink();
    }, 800);
  }

  /* ------------------------------------------------------------------ */
  /* 与扩展图标弹窗通信                                                   */
  /* ------------------------------------------------------------------ */

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === "DSV_SET_ALL") {
      const count = setAllThink(Boolean(msg.open));
      scheduleThink();
      sendResponse({ ok: true, count });
      return false;
    }
    if (msg?.type === "DSV_FORCE_STATIC") {
      ensureStaticVirtualList({ force: true });
      sendResponse({ ok: true });
      return false;
    }
    if (msg?.type === "DSV_STATUS") {
      const blocks = thinkBlocks();
      const msgCount = document.querySelectorAll(".ds-virtual-list-visible-items > div, [data-virtual-list-item-key]").length;
      sendResponse({
        ok: true,
        staticActive: !isVirtualListActive(),
        msgCount,
        thinkCount: blocks.length,
        openCount: blocks.filter((b) => isOpenBlock(b.container)).length,
        mathCount: document.querySelectorAll(".dsv-math").length
      });
      return false;
    }
    return false;
  });
})();
