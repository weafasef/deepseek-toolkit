// content.js —— DeepSeek 网页增强（思维链折叠 + LaTeX 兼容渲染 + 公式源码复制）
// 只在 https://chat.deepseek.com/* 生效

(() => {
  if (window.__dsToolkitLoaded) return;
  window.__dsToolkitLoaded = true;

  const DEFAULTS = {
    readerDefault: true,       // 默认直接打开扩展覆盖页
    collapseDefault: true,     // 思维链默认收起
    autoCollapseOnDone: true,  // 生成完成自动收起
    rememberState: true,       // 记住每条的展开状态
    latexConvert: true,        // 把 \[...\] / \(...\) 转成公式渲染
    latexCopy: true,           // 复制公式时输出完整 LaTeX
    copyWithDelimiters: true   // 复制时带上 $ / $$ 定界符
  };

  let settings = { ...DEFAULTS };
  let storedThinkState = {};   // 持久化的展开状态：{ key: "open" | "closed" }
  let userTouched = new WeakSet();       // 本页内用户手动改过的块
  let wasGenerating = new WeakSet();     // 曾处于“正在思考”的块
  const clickLock = new WeakMap();       // 防止连续点击同一块
  let syntheticClick = false;
  let lastScrollAt = 0;
  let scrollIdleTimer = 0;

  const HAVE_KATEX = typeof katex !== "undefined" && katex && typeof katex.renderToString === "function";

  const BLOCK_TAGS = new Set([
    "ADDRESS", "ARTICLE", "ASIDE", "BLOCKQUOTE", "DIV", "DL", "FIELDSET", "FIGCAPTION",
    "FIGURE", "FOOTER", "FORM", "H1", "H2", "H3", "H4", "H5", "H6", "HEADER", "HR",
    "LI", "MAIN", "NAV", "OL", "P", "PRE", "SECTION", "TABLE", "TR", "UL"
  ]);

  /* ------------------------------------------------------------------ */
  /* 设置                                                                 */
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
      scheduleScan(0);
      scheduleThink(0);
    }
    if (changes.dsToolkitThinkState) {
      storedThinkState = changes.dsToolkitThinkState.newValue || {};
    }
  });

  function saveThinkState() {
    if (!settings.rememberState) return;
    try {
      chrome.storage.local.set({ dsToolkitThinkState: storedThinkState });
    } catch {
      // ignore
    }
  }

  /* ------------------------------------------------------------------ */
  /* 思维链折叠                                                           */
  /* ------------------------------------------------------------------ */

  const CONTAINER_SELECTOR = 'div[style*="--collapsible-area-title-height"]';

  function blockTitle(header) {
    const raw = typeof header.innerText === "string" ? header.innerText : header.textContent || "";
    let t = raw.replace(/\s+/g, " ").trim();
    // “正在思考”那串带扫光动画的文字在 DOM 里会重复一次
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

  // 视觉上是否收起：用属性 + CSS 直接隐藏，React 内部可能仍认为“展开”
  function isCollapsedBlock(container) {
    return container.hasAttribute("data-dsv-collapsed") || !hasThinkContent(container);
  }

  function isOpenBlock(container) {
    return !isCollapsedBlock(container);
  }

  /* 用虚拟列表给每条消息的稳定 key 当状态标识，不再用“第几个” */
  const syntheticIds = new WeakMap();
  let syntheticSeq = 0;

  function containerId(container) {
    const item = container.closest("[data-virtual-list-item-key]");
    const attr = item && item.getAttribute("data-virtual-list-item-key");
    if (attr) return `m${attr}`;
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
      // 折叠：加属性让 CSS 隐藏，高度在本次布局就定下来，不必等 React 异步提交
      if (hasThinkContent(block.container)) {
        block.container.setAttribute("data-dsv-collapsed", "1");
      }
    } else if (block.container.hasAttribute("data-dsv-collapsed")) {
      block.container.removeAttribute("data-dsv-collapsed");
    } else {
      // React 内部是关的，只能点开（少见的“恢复记住的展开状态”）
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

  /* ---------------- 滚动守卫 ---------------- */
  /* 滚动中以及停下后的短时间内，不改任何高度：虚拟列表正在测量，改了就会跳 */

  function isScrolling() {
    return Date.now() - lastScrollAt < 450;
  }

  function onScrollActivity() {
    lastScrollAt = Date.now();
    clearTimeout(scrollIdleTimer);
    scrollIdleTimer = setTimeout(() => {
      syncThink();
      scheduleScan(0);
    }, 520);
  }

  window.addEventListener("scroll", onScrollActivity, true);
  window.addEventListener("wheel", onScrollActivity, { passive: true, capture: true });
  window.addEventListener("touchmove", onScrollActivity, { passive: true, capture: true });

  /* ---------------- 视口判断 ---------------- */

  function scrollParentOf(el) {
    let p = el && el.parentElement;
    while (p && p !== document.body && p !== document.documentElement) {
      const style = getComputedStyle(p);
      if (/(auto|scroll)/.test(style.overflowY) && p.scrollHeight > p.clientHeight + 20) return p;
      p = p.parentElement;
    }
    return document.scrollingElement || document.documentElement;
  }

  function isNearBottom(el) {
    const scroller = scrollParentOf(el);
    if (!scroller) return true;
    return scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 160;
  }

  function isBelowViewport(el) {
    return el.getBoundingClientRect().top > window.innerHeight + 40;
  }

  /* 停在底部时可以改上面的高度；否则只动视口下方的块 */
  function mayAdjust(block, nearBottom) {
    if (nearBottom) return true;
    return isBelowViewport(block.container);
  }

  let thinkQueued = false;
  function scheduleThink() {
    if (thinkQueued) return;
    thinkQueued = true;
    // 微任务里执行：赶在浏览器绘制之前，避免“先展开再收起”的闪烁
    queueMicrotask(() => {
      thinkQueued = false;
      syncThink();
    });
  }

  function syncThink() {
    if (!settings.collapseDefault && !settings.autoCollapseOnDone && !settings.rememberState) return;
    if (isScrolling()) return;

    const blocks = thinkBlocks();
    if (!blocks.length) return;
    const nearBottom = isNearBottom(blocks[0].container);

    for (const block of blocks) {
      const generating = isGeneratingTitle(block.title);
      if (generating) {
        wasGenerating.add(block.container);
        continue;
      }
      if (!isFinishedTitle(block.title)) continue;
      if (userTouched.has(block.container)) continue;
      if (!mayAdjust(block, nearBottom)) continue;

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

      // “默认收起”负责历史消息；“生成完成自动收起”负责本轮亲眼看着它从思考变成完成的块
      const seenGenerating = wasGenerating.has(block.container);
      const shouldCollapse =
        (settings.collapseDefault && !seenGenerating) ||
        (settings.autoCollapseOnDone && seenGenerating);
      if (shouldCollapse && open) {
        setBlockOpen(block, false);
      }
    }
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
    return blocks.length;
  }

  // 记录用户自己点的展开/收起（合成点击不算）
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

      // 我们自己用 CSS 藏起来的块，React 内部仍是“展开”：
      // 直接放开属性并拦掉这次点击，避免 React 又把它切成“关闭”导致点不开
      if (container.hasAttribute("data-dsv-collapsed") && hasThinkContent(container)) {
        container.removeAttribute("data-dsv-collapsed");
        e.preventDefault();
        e.stopPropagation();
        rememberBlock(blockKey(container, title), true);
        return;
      }

      setTimeout(() => {
        const open = isOpenBlock(container);
        rememberBlock(blockKey(container, blockTitle(header) || title), open);
      }, 120);
    },
    true
  );

  /* ------------------------------------------------------------------ */
  /* LaTeX：把 \[...\] / \(...\) 重新渲染成公式                            */
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
      if (SKIP.has(node.tagName)) {
        push(null, "\u0000");
        return;
      }
      if (node.classList && (node.classList.contains("katex") || node.classList.contains("dsv-math") || node.classList.contains("ds-markdown-cite"))) {
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
    // 圆括号在正常文字里太常见，必须有 LaTeX 命令才当作公式
    if (isParen) return hasCommand;
    // 方括号：有命令、有 ^/_ 这类明显数学记号、或数学符号够多
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
    // 去掉互相重叠的候选，短的重叠项丢弃
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

  // 去掉整段外面的孤立括号（模型只写了 \] 或者括号单独占一行的情况）
  function cleanBareTex(text) {
    let t = text.trim();
    t = t.replace(/^\[\s*\n+/, "");
    t = t.replace(/\n+\s*\]\]?$/, "");
    t = t.replace(/^\[\s+/, "");
    t = t.replace(/\s+\]\]?$/, "");
    return t.trim();
  }

  // 去掉花括号内容和 LaTeX 命令后，如果还剩 3 个以上的连续英文字母，说明这段是“句子里夹着公式”
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
    // 必须有 LaTeX 命令，或者 ^{ } / _{ } 这种结构
    if (!/\\[a-zA-Z]{2,}/.test(t) && !/\^\{|_\{/.test(t)) return false;
    // 还必须有等式或明显的公式命令，避免把「so [ \alpha ] ok」这种句子当成公式
    if (!/=/.test(t) && !/\\(frac|sqrt|sum|int|partial|begin|implies|Rightarrow|to|cdot|times|le|ge|neq|approx)\b/.test(t)) {
      return false;
    }
    // 句子里夹着公式（如“inline [ \frac{1}{2} ] end”）交给括号规则处理，不走整段公式
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

  function scanBlock(block) {
    const map = buildTextMap(block);
    if (!map.text) return;

    // 情况一：整段本身就是 LaTeX（常见于 \[ ... \] 被渲染成纯文本，或只剩一个收尾的 ]）
    if (!block.querySelector("a") && looksLikeBareTex(map.text)) {
      const node = buildMathNode(cleanBareTex(map.text), true);
      if (node) {
        block.replaceChildren(node);
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
      const tex = match.inner.trim();
      const node = buildMathNode(tex, display);
      if (!node) continue;

      try {
        const range = document.createRange();
        range.setStart(startPos.node, startPos.offset);
        range.setEnd(endPos.node, endPos.offset);
        range.deleteContents();
        range.insertNode(node);
      } catch {
        // 跨节点替换失败时跳过，不影响原文
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
    const text = block.textContent || "";
    let count = 0;
    for (let i = 0; i < text.length; i++) {
      const ch = text.charCodeAt(i);
      if (ch === 91 || ch === 40) count++;
    }
    return text.length + "|" + count + "|" + text.slice(-40);
  }

  function scanMathIn(scope, { checkViewport = false, nearBottom = true } = {}) {
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
        if (!/[\[(\\^_{]/.test(block.textContent || "")) continue;
        if (checkViewport && !nearBottom && !block.closest("#dsv-reader") && block.getBoundingClientRect().top < 0) {
          continue;
        }
        const sig = signatureOf(block);
        if (blockSignature.get(block) === sig) continue;
        blockSignature.set(block, sig);
        scanBlock(block);
      }
    }
  }

  function scanMath() {
    if (!settings.latexConvert || !HAVE_KATEX) return;
    if (readerEl) scanMathIn(readerEl, { checkViewport: false });
    if (isScrolling()) {
      scheduleScan(500);
      return;
    }
    const anchor = document.querySelector(".ds-markdown");
    const nearBottom = anchor ? isNearBottom(anchor) : true;
    scanMathIn(document.body, { checkViewport: true, nearBottom });
  }

  let scanScheduled = false;
  function scheduleScan(delay = 300) {
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
      // 某些实现没有 intersectsNode
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

      if (set.has(node)) {
        if (rangeHits(range, node) && !inserted.has(node)) {
          inserted.add(node);
          const formatted = formatTex(node, settings.copyWithDelimiters);
          // 少数走 SVG 回退的公式没有 TeX 标注，退化成原文本，至少不丢内容
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

    // 选区可能整个落在公式内部：要从公式元素本身开始遍历，才能把整段源码输出
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
        // 某些环境下 clipboardData 为空，交回浏览器默认处理
      }
    },
    true
  );

  /* ------------------------------------------------------------------ */
  /* 观察与巡检                                                           */
  /* ------------------------------------------------------------------ */

  let lastPath = location.pathname;

  // 新消息挂载时，赶在浏览器绘制之前把状态定下来（折叠用属性，不改 React）
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
    for (const m of mutations) {
      if (!m.addedNodes || !m.addedNodes.length) continue;
      for (const node of m.addedNodes) {
        if (node.nodeType === 1) applyInstantState(node);
      }
    }
    scheduleThink();
    scheduleScan(300);
  });

  function startObserver() {
    try {
      observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    } catch {
      // ignore
    }
  }

  // 兜底巡检：处理虚拟列表重新挂载、SPA 切换会话等情况
  setInterval(() => {
    if (location.pathname !== lastPath) {
      lastPath = location.pathname;
      // 切换到另一个会话：重置“本页初始状态”相关的记忆
      userTouched = new WeakSet();
      wasGenerating = new WeakSet();
      scheduleThink(300);
      scheduleScan(300);
    }
    scanMath();
    syncThink();
  }, 2500);

  function boot() {
    startObserver();
    ensureFab();
    syncThink();
    scanMath();
    if (settings.readerDefault && !readerUserClosed) {
      openReader();
    }
    requestAnimationFrame(() => {
      syncThink();
      scanMath();
    });
    setTimeout(() => {
      scanMath();
      syncThink();
    }, 1200);
  }

  /* ------------------------------------------------------------------ */
  /* 扩展覆盖页（默认启用：静态长文档 + 直接提问/深度思考/搜索/会话切换）    */
  /* ------------------------------------------------------------------ */

  let readerEl = null;
  let readerRestore = null;
  let readerWatch = null;
  let readerSyncTimer = 0;
  let readerKeys = new Set();
  let readerBody = null;
  let readerStatus = null;
  let readerMeta = null;
  let readerTitleEl = null;
  let readerSendBtn = null;
  let readerInput = null;
  let readerThinkPill = null;
  let readerSearchPill = null;
  let readerSessionsEl = null;
  let readerSending = false;
  let readerUserClosed = false;
  let harvestToken = 0;
  let readerSessionPath = "";
  const readerThinkManual = new Map(); // key -> "open" | "closed"
  const readerSeenGenerating = new Set();
  const sessionCache = new Map(); // pathname -> Map(key -> clonedElement)

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function nextFrameAndDelay(ms = 32) {
    return new Promise((resolve) => {
      requestAnimationFrame(() => setTimeout(resolve, ms));
    });
  }

  function ensureFab() {
    if (document.getElementById("dsv-fab")) return;
    const fab = document.createElement("button");
    fab.id = "dsv-fab";
    fab.type = "button";
    fab.textContent = "📖 扩展页面";
    fab.title = "打开 DeepSeek 扩展长文档页面";
    fab.addEventListener("click", () => {
      readerUserClosed = false;
      openReader();
    });
    document.body.appendChild(fab);
  }

  function siteVirtualItems() {
    const out = [];
    for (const el of document.querySelectorAll("[data-virtual-list-item-key]")) {
      if (readerEl && readerEl.contains(el)) continue;
      const key = el.getAttribute("data-virtual-list-item-key");
      if (key === "-999") continue;
      out.push(el);
    }
    return out;
  }

  function isAssistantItem(el) {
    if (!el) return false;
    if (el.classList && (el.classList.contains("_4f9bf79") || el.classList.contains("b4e4476b"))) return true;
    return Boolean(
      el.querySelector(".ds-assistant-message-main-content, ._4f9bf79, .b4e4476b, ._2f297cc") ||
      el.querySelector(CONTAINER_SELECTOR)
    );
  }

  // 判断是否是刚发出消息时还没返回任何文字的“• • •”空白加载占位
  function isEmptyLoadingPlaceholder(el) {
    if (!el) return true;
    const key = el.getAttribute("data-virtual-list-item-key") || "";
    const hasMain = Boolean(el.querySelector(".ds-assistant-message-main-content"));
    const hasThink = Boolean(el.querySelector(CONTAINER_SELECTOR));
    const hasUserBubble = Boolean(el.querySelector(".fbb737a4"));
    const text = (el.textContent || "").replace(/[\s•·.…]/g, "").trim();
    if (!text && !hasMain && !hasThink && !hasUserBubble && !el.querySelector("img, pre, table")) {
      return true;
    }
    // 负数 key 的助手占位块，如果既没有思考块也没有正文，属于即将被服务端 ID 替换的临时点动画
    if (Number(key) < 0 && isAssistantItem(el) && !hasMain && !hasThink) {
      return true;
    }
    return false;
  }

  function enhanceCodeBlocks(root) {
    for (const block of root.querySelectorAll(".md-code-block")) {
      const banner = block.querySelector(".md-code-block-banner") || block.firstElementChild;
      if (!banner) continue;
      // 移除原网页代码块里失效的图标按钮，换成我们自己的复制按钮
      for (const oldAct of banner.querySelectorAll(".md-code-block-action, .ds-icon-button")) {
        oldAct.remove();
      }
      if (!banner.querySelector(".dsv-code-copy-btn")) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "dsv-code-copy-btn";
        btn.textContent = "复制代码";
        banner.appendChild(btn);
      }
    }
  }

  function sanitizeAssistantClone(src, key) {
    const wrap = document.createElement("div");
    wrap.className = "dsv-assistant-content";

    // 白名单提取 1：思考/搜索折叠块
    for (const origThink of src.querySelectorAll(CONTAINER_SELECTOR)) {
      const think = origThink.cloneNode(true);
      for (const node of think.querySelectorAll("[id]")) node.removeAttribute("id");
      const header = think.firstElementChild;
      const title = header ? blockTitle(header) : "";
      const generating = isGeneratingTitle(title);
      if (generating) readerSeenGenerating.add(key);

      const manual = readerThinkManual.get(key);
      if (manual === "open") {
        think.removeAttribute("data-dsv-collapsed");
      } else if (manual === "closed") {
        think.setAttribute("data-dsv-collapsed", "1");
      } else if (generating) {
        think.removeAttribute("data-dsv-collapsed");
      } else {
        const wasGen = readerSeenGenerating.has(key);
        const shouldCollapse =
          (wasGen && settings.autoCollapseOnDone) ||
          (!wasGen && settings.collapseDefault);
        if (shouldCollapse) think.setAttribute("data-dsv-collapsed", "1");
      }
      wrap.appendChild(think);
    }

    // 白名单提取 2：模型回答正文块 (.ds-assistant-message-main-content)
    const mainBlocks = src.querySelectorAll(".ds-assistant-message-main-content");
    if (mainBlocks.length) {
      for (const origMain of mainBlocks) {
        const main = origMain.cloneNode(true);
        for (const dup of main.querySelectorAll(CONTAINER_SELECTOR)) dup.remove();
        for (const bad of main.querySelectorAll("script, style, link, iframe, textarea")) bad.remove();
        for (const node of main.querySelectorAll("[id]")) node.removeAttribute("id");
        wrap.appendChild(main);
      }
    } else {
      // 兜底：存在非思考块的 .ds-markdown 时提取之
      for (const origMd of src.querySelectorAll(".ds-markdown")) {
        if (origMd.closest(CONTAINER_SELECTOR)) continue;
        const md = origMd.cloneNode(true);
        for (const node of md.querySelectorAll("[id]")) node.removeAttribute("id");
        wrap.appendChild(md);
      }
    }

    enhanceCodeBlocks(wrap);
    scanMathIn(wrap, { checkViewport: false });
    return wrap;
  }

  function buildUserBubble(src) {
    const bubble = document.createElement("div");
    bubble.className = "dsv-user-bubble";
    // 直接提取用户气泡内的纯文本（不保留原网页 .fbb737a4 的 calc(100% - 88px) 窄盒与 overflow:hidden 截断）
    const siteBubble =
      src.querySelector(".fbb737a4 .ds-collapsible-text") ||
      src.querySelector(".fbb737a4") ||
      src.querySelector(".ds-collapsible-text") ||
      src;
    const text = (siteBubble.textContent || "").trim();
    const textNode = document.createElement("div");
    textNode.className = "dsv-user-text";
    textNode.textContent = text;
    bubble.appendChild(textNode);
    scanMathIn(bubble, { checkViewport: false });
    return bubble;
  }

  function extractPlainWithLatex(root) {
    if (!root) return "";
    const range = document.createRange();
    range.selectNodeContents(root);
    const formulas = formulasInRange(range);
    if (formulas.length) {
      const built = buildClipboardText(range, formulas);
      if (built) return built;
    }
    return (root.innerText || root.textContent || "").trim();
  }

  function itemSignature(sourceEl) {
    const think = sourceEl.querySelector(CONTAINER_SELECTOR);
    const thinkTitle = think && think.firstElementChild ? blockTitle(think.firstElementChild) : "";
    return `${(sourceEl.textContent || "").length}|${thinkTitle}|${sourceEl.querySelectorAll(".katex, .dsv-math, pre").length}`;
  }

  function makeHolder(key, sourceEl) {
    const assistant = isAssistantItem(sourceEl);
    const hasThink = Boolean(sourceEl.querySelector(CONTAINER_SELECTOR));
    const holder = document.createElement("div");
    holder.className = `dsv-r-item ${assistant ? "dsv-role-assistant" : "dsv-role-user"}`;
    holder.dataset.key = key;
    holder.dataset.role = assistant ? "assistant" : "user";
    holder.dataset.sig = itemSignature(sourceEl);

    const contentWrap = document.createElement("div");
    contentWrap.className = "dsv-r-item-body";
    if (assistant) {
      contentWrap.appendChild(sanitizeAssistantClone(sourceEl, key));
    } else {
      contentWrap.appendChild(buildUserBubble(sourceEl));
    }

    const metaRow = document.createElement("div");
    metaRow.className = "dsv-r-meta-row";
    metaRow.innerHTML = assistant
      ? `
        ${hasThink ? '<button type="button" class="dsv-r-act-btn" data-item-act="toggle-think">折叠/展开思考</button>' : ""}
        <button type="button" class="dsv-r-act-btn" data-item-act="copy">复制全文</button>
        <button type="button" class="dsv-r-act-btn" data-item-act="regen">重新生成</button>
      `
      : `
        <button type="button" class="dsv-r-act-btn" data-item-act="copy">复制</button>
        <button type="button" class="dsv-r-act-btn" data-item-act="reask">编辑重问</button>
      `;

    holder.appendChild(contentWrap);
    holder.appendChild(metaRow);
    return holder;
  }

  function updateHolderContent(holder, sourceEl, key) {
    const nextHolder = makeHolder(key, sourceEl);
    holder.replaceWith(nextHolder);
  }

  function cleanupReplacedTempHolders() {
    if (!readerBody) return;
    const mounted = siteVirtualItems();
    if (!mounted.length) return;
    const mountedKeys = new Set(mounted.map((el) => el.getAttribute("data-virtual-list-item-key")));

    // 1. 清理原网页已删除/替换掉的负数临时 key（比如刚发送时的 -1 / -2 占位）
    for (const holder of Array.from(readerBody.querySelectorAll(".dsv-r-item"))) {
      const k = holder.dataset.key || "";
      if (Number(k) < 0 && !mountedKeys.has(k)) {
        holder.remove();
        readerKeys.delete(k);
      }
    }

    // 2. 如果最后两条同为 user 且文字完全相同（例如 -1 变成正数 id 时的瞬态），去掉前一条重复的
    const allHolders = Array.from(readerBody.querySelectorAll(".dsv-r-item"));
    if (allHolders.length >= 2) {
      const a = allHolders[allHolders.length - 2];
      const b = allHolders[allHolders.length - 1];
      if (
        a.dataset.role === "user" &&
        b.dataset.role === "user" &&
        Number(a.dataset.key) < 0 &&
        (a.querySelector(".dsv-r-item-body")?.textContent || "").trim() ===
          (b.querySelector(".dsv-r-item-body")?.textContent || "").trim()
      ) {
        readerKeys.delete(a.dataset.key);
        a.remove();
      }
    }
  }

  function readerAtBottom() {
    if (!readerBody) return true;
    return readerBody.scrollHeight - readerBody.scrollTop - readerBody.clientHeight < 140;
  }

  function readerScrollBottom() {
    if (readerBody) readerBody.scrollTop = readerBody.scrollHeight;
  }

  function setReaderStatus(text) {
    if (readerStatus) readerStatus.textContent = text || "";
  }

  /* -------- 与原页面控件联动（输入框、深度思考、联网搜索、停止生成、会话栏） -------- */

  function findSiteComposer() {
    const list = Array.from(document.querySelectorAll('textarea[name="search"], textarea, [contenteditable="true"]')).filter(
      (el) => !readerEl || !readerEl.contains(el)
    );
    if (!list.length) return null;
    list.sort((a, b) => b.getBoundingClientRect().bottom - a.getBoundingClientRect().bottom);
    return list[0];
  }

  function findSiteToggleButtons() {
    let thinkBtn = null;
    let searchBtn = null;
    const candidates = document.querySelectorAll('.ds-toggle-button, [role="button"], button');
    for (const el of candidates) {
      if (readerEl && readerEl.contains(el)) continue;
      const t = (el.textContent || "").replace(/\s+/g, " ").trim();
      if (!thinkBtn && /^(深度思考|DeepThink)(\s|$)/i.test(t)) thinkBtn = el;
      if (!searchBtn && /^(智能搜索|联网搜索|Search)(\s|$)/i.test(t)) searchBtn = el;
    }
    return { thinkBtn, searchBtn };
  }

  function isToggleSelected(btn) {
    if (!btn) return false;
    if (btn.classList.contains("ds-toggle-button--selected")) return true;
    if (btn.getAttribute("aria-pressed") === "true") return true;
    return false;
  }

  function syncComposerPills() {
    if (!readerEl) return;
    const { thinkBtn, searchBtn } = findSiteToggleButtons();
    if (readerThinkPill) {
      readerThinkPill.classList.toggle("active", isToggleSelected(thinkBtn));
      readerThinkPill.disabled = !thinkBtn;
    }
    if (readerSearchPill) {
      readerSearchPill.classList.toggle("active", isToggleSelected(searchBtn));
      readerSearchPill.disabled = !searchBtn;
    }
  }

  function findSitePrimaryActionBtn(composer) {
    let box = composer || findSiteComposer();
    for (let i = 0; i < 6 && box; i++, box = box.parentElement) {
      const btns = Array.from(
        box.querySelectorAll('button, [role="button"], .ds-icon-button')
      ).filter(
        (b) =>
          (!readerEl || !readerEl.contains(b)) &&
          !b.classList.contains("ds-toggle-button") &&
          b.getBoundingClientRect().width > 0
      );
      if (btns.length) {
        btns.sort((a, b) => b.getBoundingClientRect().right - a.getBoundingClientRect().right);
        return btns[0];
      }
    }
    return null;
  }

  function isSiteGenerating() {
    const items = siteVirtualItems();
    const last = items[items.length - 1];
    if (!last) return false;
    if (isEmptyLoadingPlaceholder(last) && isAssistantItem(last)) return true;
    const think = last.querySelector(CONTAINER_SELECTOR);
    if (think && think.firstElementChild) {
      const title = blockTitle(think.firstElementChild);
      if (isGeneratingTitle(title)) return true;
    }
    return false;
  }

  function syncStopButtonState() {
    if (!readerSendBtn) return;
    const generating = isSiteGenerating();
    if (generating) {
      readerSendBtn.textContent = "⏹ 停止";
      readerSendBtn.classList.add("stopping");
      readerSendBtn.disabled = false;
    } else {
      readerSendBtn.textContent = "↑ 发送";
      readerSendBtn.classList.remove("stopping");
      readerSendBtn.disabled = readerSending;
    }
  }

  function stopSiteGeneration() {
    const btn = findSitePrimaryActionBtn();
    if (btn) {
      btn.click();
      setReaderStatus("已停止生成");
      setTimeout(syncStopButtonState, 120);
      return true;
    }
    return false;
  }

  async function sendToSite(text) {
    const composer = findSiteComposer();
    if (!composer) return { ok: false, reason: "没找到页面的输入框，请确认已登录" };

    // 先 focus 触发 DeepSeek 的 PoW 预热
    composer.focus();
    await sleep(30);

    if (composer.tagName === "TEXTAREA") {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
      setter.call(composer, text);
      composer.dispatchEvent(new Event("input", { bubbles: true }));
    } else {
      composer.textContent = text;
      composer.dispatchEvent(new InputEvent("input", { bubbles: true, data: text }));
    }

    await sleep(40);
    const beforePath = location.pathname;

    // 只派发一次 keydown Enter（与原页面 onKeyDown 行为完全一致，避免重复触发）
    const opts = { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true };
    composer.dispatchEvent(new KeyboardEvent("keydown", opts));

    await sleep(320);
    // 只有当原输入框里的文字还没被清空时，才兜底点一次发送按钮
    if ((composer.value || "").trim() === text.trim() && location.pathname === beforePath) {
      const btn = findSitePrimaryActionBtn(composer);
      if (btn) btn.click();
      await sleep(300);
    }

    const cleared = !(composer.value || "").trim();
    return { ok: cleared || location.pathname !== beforePath };
  }

  function syncSidebarSessions() {
    if (!readerSessionsEl) return;
    const links = Array.from(document.querySelectorAll('a[href*="/a/chat/s/"]')).filter(
      (a) => !readerEl || !readerEl.contains(a)
    );
    const curPath = location.pathname;

    if (readerTitleEl) {
      const activeLink = links.find((a) => a.getAttribute("href") === curPath);
      const pageTitle = (activeLink?.textContent || document.title || "DeepSeek 对话")
        .replace(/\s*-\s*DeepSeek\s*$/i, "")
        .trim();
      readerTitleEl.textContent = pageTitle || "DeepSeek 对话";
    }

    if (!links.length) {
      readerSessionsEl.innerHTML = `<div class="dsv-r-session-empty">暂无历史会话列表</div>`;
      return;
    }

    const sig = links.map((a) => `${a.getAttribute("href")}:${(a.textContent || "").trim()}`).join("|") + "|" + curPath;
    if (readerSessionsEl.dataset.sig === sig) return;
    readerSessionsEl.dataset.sig = sig;

    const frag = document.createDocumentFragment();
    for (const a of links) {
      const href = a.getAttribute("href") || "";
      const title = (a.textContent || "").replace(/\s+/g, " ").trim() || "未命名对话";
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "dsv-r-session-item" + (href === curPath ? " active" : "");
      btn.dataset.href = href;
      btn.textContent = title;
      btn.title = title;
      frag.appendChild(btn);
    }
    readerSessionsEl.replaceChildren(frag);
  }

  function triggerNewChat() {
    const candidates = Array.from(document.querySelectorAll('div[tabindex="0"], button, a, [role="button"]')).filter(
      (el) => !readerEl || !readerEl.contains(el)
    );
    for (const el of candidates) {
      const t = (el.textContent || "").replace(/\s+/g, " ").trim();
      if (t === "开启新对话" || t === "New chat") {
        el.click();
        return;
      }
    }
    if (location.pathname !== "/") {
      history.pushState({}, "", "/");
      window.dispatchEvent(new PopStateEvent("popstate"));
    }
  }

  /* ---------------- 极速抓取（0ms 首屏 + 后台高速向上补齐） ---------------- */

  async function harvestAndRenderSession(token) {
    const sessionPath = location.pathname;
    readerSessionPath = sessionPath;
    readerKeys = new Set();

    const initialEls = siteVirtualItems().filter((el) => !isEmptyLoadingPlaceholder(el));
    if (!initialEls.length) {
      const cached = sessionCache.get(sessionPath);
      if (cached && cached.size) {
        const frag = document.createDocumentFragment();
        for (const [key, clone] of cached.entries()) {
          readerKeys.add(key);
          frag.appendChild(makeHolder(key, clone));
        }
        readerBody.replaceChildren(frag);
        readerScrollBottom();
        if (readerMeta) readerMeta.textContent = `${readerKeys.size} 条消息`;
        return;
      }
      readerBody.innerHTML = `<div class="dsv-r-loading">新对话 · 直接在下方输入问题开始提问</div>`;
      if (readerMeta) readerMeta.textContent = "新对话";
      return;
    }

    const scroller = scrollParentOf(initialEls[0]);
    const originalTop = scroller ? scroller.scrollTop : 0;
    readerRestore = { scroller, originalTop };

    // 第 1 步（0ms）：先把当前视口已挂载的最新消息立刻渲染出来并滚到底部
    const collected = new Map();
    const initialFrag = document.createDocumentFragment();
    for (const el of initialEls) {
      const key = el.getAttribute("data-virtual-list-item-key");
      if (!key || readerKeys.has(key)) continue;
      const clone = el.cloneNode(true);
      collected.set(key, clone);
      readerKeys.add(key);
      initialFrag.appendChild(makeHolder(key, clone));
    }
    readerBody.replaceChildren(initialFrag);
    readerScrollBottom();
    if (readerMeta) readerMeta.textContent = `已加载 ${readerKeys.size} 条…`;

    // 第 2 步：如果原页面上方还有历史消息，高速向上滚动补齐并无感插入顶部
    const MAX_ITEMS = 1000;
    const MAX_MS = 25000;
    const started = Date.now();
    let idle = 0;

    if (scroller && scroller.scrollTop > 0) {
      for (let step = 0; step < 320; step++) {
        if (token !== harvestToken || !readerEl) return;
        if (readerKeys.size >= MAX_ITEMS || Date.now() - started > MAX_MS) break;

        if (scroller.scrollTop <= 0) {
          if (idle++ >= 1) break;
        } else {
          idle = 0;
        }

        const span = Math.max(420, scroller.clientHeight * 1.25);
        scroller.scrollTop = Math.max(0, scroller.scrollTop - span);
        scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
        await nextFrameAndDelay(32);
        if (token !== harvestToken || !readerEl) return;

        const batch = [];
        for (const el of siteVirtualItems()) {
          if (isEmptyLoadingPlaceholder(el)) continue;
          const key = el.getAttribute("data-virtual-list-item-key");
          if (!key || readerKeys.has(key)) continue;
          const clone = el.cloneNode(true);
          collected.set(key, clone);
          readerKeys.add(key);
          batch.push(makeHolder(key, clone));
        }

        if (batch.length) {
          const prevHeight = readerBody.scrollHeight;
          const prevTop = readerBody.scrollTop;
          const frag = document.createDocumentFragment();
          for (const h of batch) frag.appendChild(h);
          readerBody.insertBefore(frag, readerBody.firstChild);
          const delta = readerBody.scrollHeight - prevHeight;
          readerBody.scrollTop = prevTop + delta;
          if (readerMeta) readerMeta.textContent = `已同步 ${readerKeys.size} 条…`;
        }
      }

      scroller.scrollTop = scroller.scrollHeight;
      scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
    }

    if (token !== harvestToken || !readerEl) return;
    if (readerMeta) readerMeta.textContent = `${readerKeys.size} 条消息`;

    const orderedCache = new Map();
    for (const itemEl of readerBody.querySelectorAll(".dsv-r-item")) {
      const k = itemEl.dataset.key;
      if (k && collected.has(k)) orderedCache.set(k, collected.get(k));
    }
    if (orderedCache.size) sessionCache.set(sessionPath, orderedCache);
  }

  function syncLatestItemsToReader() {
    if (!readerEl || !readerBody) return;
    cleanupReplacedTempHolders();

    const els = siteVirtualItems();
    const tail = els.slice(-3);
    for (const item of tail) {
      if (isEmptyLoadingPlaceholder(item)) continue;
      const key = item.getAttribute("data-virtual-list-item-key");
      if (!key) continue;
      let holder = readerBody.querySelector(`.dsv-r-item[data-key="${CSS.escape(key)}"]`);
      if (!holder) {
        readerKeys.add(key);
        const loadingPlaceholder = readerBody.querySelector(".dsv-r-loading");
        if (loadingPlaceholder) loadingPlaceholder.remove();
        const atBottom = readerAtBottom();
        holder = makeHolder(key, item);
        readerBody.appendChild(holder);
        cleanupReplacedTempHolders();
        if (atBottom) readerScrollBottom();
        if (readerMeta) readerMeta.textContent = `${readerBody.querySelectorAll(".dsv-r-item").length} 条消息`;
        continue;
      }
      const sig = itemSignature(item);
      if (holder.dataset.sig === sig) continue;
      const atBottom = readerAtBottom();
      updateHolderContent(holder, item, key);
      if (atBottom) readerScrollBottom();
    }
  }

  function watchNewMessages() {
    if (readerWatch) readerWatch.disconnect();
    readerWatch = new MutationObserver(() => {
      syncLatestItemsToReader();
    });
    readerWatch.observe(document.body, { childList: true, subtree: true });
  }

  function startSyncTimer() {
    clearInterval(readerSyncTimer);
    readerSyncTimer = setInterval(() => {
      if (!readerEl || !readerBody) return;

      syncComposerPills();
      syncStopButtonState();
      syncSidebarSessions();
      syncLatestItemsToReader();

      if (isSiteGenerating()) {
        setReaderStatus("DeepSeek 正在回答…");
      } else if (readerStatus && readerStatus.textContent === "DeepSeek 正在回答…") {
        setReaderStatus("");
      }
    }, 160);
  }

  async function openReader() {
    if (readerEl) {
      if (readerSessionPath !== location.pathname) {
        const token = ++harvestToken;
        await harvestAndRenderSession(token);
      }
      return;
    }

    readerEl = document.createElement("div");
    readerEl.id = "dsv-reader";
    readerEl.innerHTML = `
      <header class="dsv-r-header">
        <button class="dsv-r-btn" data-act="toggle-sidebar" title="展开/收起会话列表">☰ 会话</button>
        <span class="dsv-r-title">DeepSeek 对话</span>
        <span class="dsv-r-meta">准备就绪</span>
        <input class="dsv-r-search" type="search" placeholder="搜索当前对话…" />
        <button class="dsv-r-btn" data-act="collapse">收起思考</button>
        <button class="dsv-r-btn" data-act="expand">展开思考</button>
        <button class="dsv-r-btn" data-act="top" title="跳到顶部">↑</button>
        <button class="dsv-r-btn" data-act="bottom" title="跳到底部">↓</button>
        <button class="dsv-r-btn dsv-r-close" data-act="close" title="暂时切回 DeepSeek 原版页面">切回原版</button>
      </header>
      <div class="dsv-r-main">
        <aside class="dsv-r-sidebar">
          <div class="dsv-r-side-top">
            <button type="button" class="dsv-r-newchat" data-act="new-chat">＋ 开启新对话</button>
          </div>
          <div class="dsv-r-sessions"></div>
        </aside>
        <div class="dsv-r-workspace">
          <div class="dsv-r-body">
            <div class="dsv-r-loading">正在同步当前对话…</div>
          </div>
          <footer class="dsv-r-footer">
            <div class="dsv-r-composer-card">
              <textarea rows="1" placeholder="给 DeepSeek 发送消息…（Enter 发送，Shift+Enter 换行）"></textarea>
              <div class="dsv-r-toolbar">
                <button type="button" class="dsv-r-pill" data-act="toggle-deepthink">🧠 深度思考</button>
                <button type="button" class="dsv-r-pill" data-act="toggle-search">🌐 联网搜索</button>
                <span class="dsv-r-status"></span>
                <button type="button" class="dsv-r-send">↑ 发送</button>
              </div>
            </div>
          </footer>
        </div>
      </div>
    `;
    document.body.appendChild(readerEl);
    document.body.classList.add("dsv-reader-open");

    readerBody = readerEl.querySelector(".dsv-r-body");
    readerStatus = readerEl.querySelector(".dsv-r-status");
    readerMeta = readerEl.querySelector(".dsv-r-meta");
    readerTitleEl = readerEl.querySelector(".dsv-r-title");
    readerSendBtn = readerEl.querySelector(".dsv-r-send");
    readerInput = readerEl.querySelector(".dsv-r-composer-card textarea");
    readerThinkPill = readerEl.querySelector('[data-act="toggle-deepthink"]');
    readerSearchPill = readerEl.querySelector('[data-act="toggle-search"]');
    readerSessionsEl = readerEl.querySelector(".dsv-r-sessions");

    syncComposerPills();
    syncSidebarSessions();
    watchNewMessages();
    startSyncTimer();

    const token = ++harvestToken;
    harvestAndRenderSession(token);

    async function submit() {
      if (isSiteGenerating()) {
        stopSiteGeneration();
        return;
      }
      const text = (readerInput.value || "").trim();
      if (!text || readerSending) return;
      readerSending = true;
      readerSendBtn.disabled = true;
      setReaderStatus("正在发送…");
      const res = await sendToSite(text);
      if (res.ok) {
        readerInput.value = "";
        readerInput.style.height = "44px";
        setReaderStatus("已发送，等待回答…");
        setTimeout(() => readerScrollBottom(), 100);
      } else {
        setReaderStatus(res.reason || "发送失败，请切回原版检查输入框状态");
      }
      readerSending = false;
      syncStopButtonState();
      readerInput.focus();
    }

    readerSendBtn.addEventListener("click", submit);
    readerInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        submit();
      }
    });
    readerInput.addEventListener("input", () => {
      readerInput.style.height = "auto";
      readerInput.style.height = `${Math.min(180, Math.max(44, readerInput.scrollHeight))}px`;
    });
    setTimeout(() => readerInput && readerInput.focus(), 120);
  }

  function closeReader({ byUser = false } = {}) {
    if (!readerEl) return;
    if (byUser) readerUserClosed = true;
    harvestToken++;
    if (readerWatch) readerWatch.disconnect();
    clearInterval(readerSyncTimer);
    readerWatch = null;
    readerEl.remove();
    readerEl = null;
    readerBody = null;
    readerStatus = null;
    readerMeta = null;
    readerTitleEl = null;
    readerSendBtn = null;
    readerInput = null;
    readerThinkPill = null;
    readerSearchPill = null;
    readerSessionsEl = null;
    document.body.classList.remove("dsv-reader-open");
    if (readerRestore && readerRestore.scroller) {
      try {
        readerRestore.scroller.scrollTop = readerRestore.originalTop;
      } catch {
        // ignore
      }
    }
    readerRestore = null;
  }

  // 监听会话路径切换（例如从侧边栏切换对话，或新对话发出第一条消息后跳转到 /a/chat/s/...）
  setInterval(() => {
    if (location.pathname !== lastPath) {
      const prevPath = lastPath;
      lastPath = location.pathname;
      userTouched = new WeakSet();
      wasGenerating = new WeakSet();
      scheduleThink(300);
      scheduleScan(300);

      if (readerEl) {
        syncSidebarSessions();
        // 从首页 "/" 发消息自动跳进新会话时，不清空当前正在流式生成的节点
        if (prevPath === "/" && /^\/a\/chat\/s\//.test(lastPath)) {
          readerSessionPath = lastPath;
        } else {
          const token = ++harvestToken;
          harvestAndRenderSession(token);
        }
      } else if (settings.readerDefault && !readerUserClosed) {
        openReader();
      }
    }
  }, 350);

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && readerEl) {
      if (document.activeElement === readerInput && readerInput.value) {
        readerInput.blur();
        return;
      }
      closeReader({ byUser: true });
    }
  }, true);

  document.addEventListener("click", (e) => {
    if (!readerEl || !readerEl.contains(e.target)) return;

    // 1. 顶部/底部工具栏按钮
    const act = e.target.closest("[data-act]");
    if (act) {
      const action = act.dataset.act;
      if (action === "close") {
        closeReader({ byUser: true });
        return;
      }
      if (action === "toggle-sidebar") {
        readerEl.classList.toggle("dsv-sidebar-collapsed");
        return;
      }
      if (action === "new-chat") {
        triggerNewChat();
        if (readerBody) {
          readerKeys.clear();
          readerBody.innerHTML = `<div class="dsv-r-loading">新对话 · 直接在下方输入问题开始提问</div>`;
        }
        if (readerMeta) readerMeta.textContent = "新对话";
        if (readerInput) readerInput.focus();
        return;
      }
      if (action === "top") {
        if (readerBody) readerBody.scrollTop = 0;
        return;
      }
      if (action === "bottom") {
        readerScrollBottom();
        return;
      }
      if (action === "collapse" || action === "expand") {
        const wantOpen = action === "expand";
        for (const item of readerEl.querySelectorAll(".dsv-r-item")) {
          const k = item.dataset.key;
          if (k) readerThinkManual.set(k, wantOpen ? "open" : "closed");
        }
        for (const think of readerEl.querySelectorAll(CONTAINER_SELECTOR)) {
          if (wantOpen) think.removeAttribute("data-dsv-collapsed");
          else think.setAttribute("data-dsv-collapsed", "1");
        }
        return;
      }
      if (action === "toggle-deepthink") {
        const { thinkBtn } = findSiteToggleButtons();
        if (thinkBtn) {
          thinkBtn.click();
          setTimeout(syncComposerPills, 60);
        }
        return;
      }
      if (action === "toggle-search") {
        const { searchBtn } = findSiteToggleButtons();
        if (searchBtn) {
          searchBtn.click();
          setTimeout(syncComposerPills, 60);
        }
        return;
      }
    }

    // 2. 左侧会话列表切换
    const sessionBtn = e.target.closest(".dsv-r-session-item");
    if (sessionBtn) {
      const href = sessionBtn.dataset.href;
      const realLink = Array.from(document.querySelectorAll('a[href*="/a/chat/s/"]')).find(
        (a) => (!readerEl || !readerEl.contains(a)) && a.getAttribute("href") === href
      );
      if (realLink) realLink.click();
      return;
    }

    // 3. 单条消息操作栏（复制全文 / 折叠思考 / 编辑重问 / 重新生成）
    const itemAct = e.target.closest("[data-item-act]");
    if (itemAct) {
      const holder = itemAct.closest(".dsv-r-item");
      if (!holder) return;
      const mode = itemAct.dataset.itemAct;
      const key = holder.dataset.key;

      if (mode === "toggle-think") {
        const think = holder.querySelector(CONTAINER_SELECTOR);
        if (think) {
          const willOpen = think.hasAttribute("data-dsv-collapsed");
          if (willOpen) think.removeAttribute("data-dsv-collapsed");
          else think.setAttribute("data-dsv-collapsed", "1");
          if (key) readerThinkManual.set(key, willOpen ? "open" : "closed");
        }
        return;
      }

      if (mode === "copy") {
        const body = holder.querySelector(".dsv-r-item-body") || holder;
        const text = extractPlainWithLatex(body);
        navigator.clipboard?.writeText(text);
        const orig = itemAct.textContent;
        itemAct.textContent = "已复制 ✓";
        setTimeout(() => {
          itemAct.textContent = orig;
        }, 1200);
        return;
      }

      if (mode === "reask") {
        const body = holder.querySelector(".dsv-r-item-body") || holder;
        const text = extractPlainWithLatex(body);
        if (readerInput) {
          readerInput.value = text;
          readerInput.dispatchEvent(new Event("input"));
          readerInput.focus();
        }
        return;
      }

      if (mode === "regen") {
        // 优先找前一条用户提问并重新发送，或填充到输入框
        let prev = holder.previousElementSibling;
        while (prev && prev.dataset.role !== "user") prev = prev.previousElementSibling;
        if (prev) {
          const body = prev.querySelector(".dsv-r-item-body") || prev;
          const prompt = extractPlainWithLatex(body);
          if (prompt && readerInput) {
            readerInput.value = prompt;
            readerSendBtn?.click();
          }
        }
        return;
      }
    }

    // 4. 代码块一键复制
    const codeBtn = e.target.closest(".dsv-code-copy-btn, .md-code-block-action");
    if (codeBtn) {
      const codeBlock = codeBtn.closest(".md-code-block");
      const pre = codeBlock?.querySelector("pre, code");
      if (pre) {
        e.preventDefault();
        e.stopPropagation();
        navigator.clipboard?.writeText(pre.textContent || "");
        const targetBtn = codeBlock.querySelector(".dsv-code-copy-btn") || codeBtn;
        const orig = targetBtn.textContent;
        targetBtn.textContent = "已复制 ✓";
        setTimeout(() => {
          targetBtn.textContent = orig;
        }, 1200);
      }
      return;
    }

    // 5. 点击思维链标题栏：切换折叠并记住手动状态
    const think = e.target.closest(CONTAINER_SELECTOR);
    if (think && think.firstElementChild && think.firstElementChild.contains(e.target)) {
      const holder = think.closest(".dsv-r-item");
      const key = holder?.dataset.key;
      const willOpen = think.hasAttribute("data-dsv-collapsed");
      if (willOpen) think.removeAttribute("data-dsv-collapsed");
      else think.setAttribute("data-dsv-collapsed", "1");
      if (key) readerThinkManual.set(key, willOpen ? "open" : "closed");
    }
  }, true);

  document.addEventListener("input", (e) => {
    if (!readerEl || e.target !== readerEl.querySelector(".dsv-r-search")) return;
    const q = (e.target.value || "").trim().toLowerCase();
    for (const item of readerEl.querySelectorAll(".dsv-r-item")) {
      item.hidden = Boolean(q) && !(item.textContent || "").toLowerCase().includes(q);
    }
  }, true);

  /* ------------------------------------------------------------------ */
  /* 与面板通信                                                           */
  /* ------------------------------------------------------------------ */

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === "DSV_SET_ALL") {
      const count = setAllThink(Boolean(msg.open));
      scheduleThink(0);
      sendResponse({ ok: true, count });
      return false;
    }
    if (msg?.type === "DSV_OPEN_READER") {
      readerUserClosed = false;
      sendResponse({ ok: true });
      openReader();
      return false;
    }
    if (msg?.type === "DSV_STATUS") {
      const blocks = thinkBlocks();
      sendResponse({
        ok: true,
        readerOpen: Boolean(readerEl),
        thinkCount: blocks.length,
        openCount: blocks.filter((b) => isOpenBlock(b.container)).length,
        mathCount: document.querySelectorAll(".dsv-math").length
      });
      return false;
    }
    return false;
  });
})();
