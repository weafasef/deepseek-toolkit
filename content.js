// content.js —— DeepSeek 网页增强（思维链折叠 + LaTeX 兼容渲染 + 公式源码复制）
// 只在 https://chat.deepseek.com/* 生效

(() => {
  if (window.__dsToolkitLoaded) return;
  window.__dsToolkitLoaded = true;

  const DEFAULTS = {
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
  let lastSelfAdjustAt = 0;

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

  function isOpenBlock(container) {
    return Boolean(container.querySelector(".ds-think-content"));
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
    const open = isOpenBlock(block.container);
    if (open === wantOpen) return false;
    const last = clickLock.get(block.container) || 0;
    if (Date.now() - last < 250) return false;
    clickLock.set(block.container, Date.now());

    // 折叠/展开会改变高度；拿“块后面的内容”当参照，改完把滚动位置补回去
    const scroller = scrollParentOf(block.container);
    const ref =
      block.container.nextElementSibling ||
      (block.container.parentElement && block.container.parentElement.nextElementSibling) ||
      null;
    const topBefore = ref ? ref.getBoundingClientRect().top : 0;

    syntheticClick = true;
    try {
      block.header.click();
    } catch {
      // ignore
    }
    syntheticClick = false;

    const compensate = () => {
      if (!scroller || !ref) return;
      if (isScrolling()) return;
      const shift = ref.getBoundingClientRect().top - topBefore;
      if (Math.abs(shift) > 0.5) {
        lastSelfAdjustAt = Date.now();
        scroller.scrollTop = scroller.scrollTop + shift;
      }
    };
    compensate();
    queueMicrotask(compensate);
    requestAnimationFrame(compensate);
    setTimeout(compensate, 80);

    if (record) rememberBlock(block.key, wantOpen);
    return true;
  }

  /* ---------------- 滚动守卫 ---------------- */
  /* 滚动中以及停下后的短时间内，不改任何高度：虚拟列表正在测量，改了就会跳 */

  function isScrolling() {
    return Date.now() - lastScrollAt < 450;
  }

  function onScrollActivity() {
    // 补偿滚动位置引起的 scroll 事件不算用户滚动
    if (Date.now() - lastSelfAdjustAt < 150) return;
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

    let acted = 0;
    for (const block of blocks) {
      if (acted >= 20) break; // 一次最多处理 20 个，剩下的等下一轮，避免卡顿
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
        if (!open && setBlockOpen(block, true)) acted++;
        continue;
      }
      if (stored === "closed") {
        if (open && setBlockOpen(block, false)) acted++;
        continue;
      }

      // “默认收起”负责历史消息；“生成完成自动收起”负责本轮亲眼看着它从思考变成完成的块
      const seenGenerating = wasGenerating.has(block.container);
      const shouldCollapse =
        (settings.collapseDefault && !seenGenerating) ||
        (settings.autoCollapseOnDone && seenGenerating);
      if (shouldCollapse && open) {
        if (setBlockOpen(block, false)) acted++;
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

  function scanMath() {
    if (!settings.latexConvert || !HAVE_KATEX) return;
    // 滚动过程中不改 DOM：虚拟列表正在测量高度
    if (isScrolling()) {
      scheduleScan(500);
      return;
    }

    const anchor = document.querySelector(".ds-markdown");
    const nearBottom = anchor ? isNearBottom(anchor) : true;

    const roots = document.querySelectorAll(".ds-markdown");
    for (const root of roots) {
      if (root.closest(".dsv-math")) continue;
      const blocks = root.querySelectorAll("p, li, td, th, h1, h2, h3, h4, h5, h6");
      for (const block of blocks) {
        if (block.closest("pre, code, .dsv-math, .md-code-block")) continue;
        if (hasBlockChild(block)) continue;
        if (!/[\[(\\^_{]/.test(block.textContent || "")) continue;
        // 不是停在底部时，不动视口上方的块，避免改变高度造成跳动
        if (!nearBottom && block.getBoundingClientRect().top < 0) continue;
        const sig = signatureOf(block);
        if (blockSignature.get(block) === sig) continue;
        blockSignature.set(block, sig);
        scanBlock(block);
      }
    }
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

  const observer = new MutationObserver(() => {
    scheduleThink(220);
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
    syncThink();
    scanMath();
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
  /* 与面板通信                                                           */
  /* ------------------------------------------------------------------ */

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === "DSV_SET_ALL") {
      const count = setAllThink(Boolean(msg.open));
      scheduleThink(0);
      sendResponse({ ok: true, count });
      return false;
    }
    if (msg?.type === "DSV_STATUS") {
      const blocks = thinkBlocks();
      sendResponse({
        ok: true,
        thinkCount: blocks.length,
        openCount: blocks.filter((b) => isOpenBlock(b.container)).length,
        mathCount: document.querySelectorAll(".dsv-math").length
      });
      return false;
    }
    return false;
  });
})();
