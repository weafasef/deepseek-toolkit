// main-world.js —— 运行在页面 MAIN world (document_start)
// 1. 防崩溃护盾：拦截 Node.prototype.removeChild / insertBefore 的 NotFoundError，
//    从根源阻止 React 因 DOM 变动抛出异常触发 DeepSeek 的 nO() "页面崩溃可能与浏览器插件有关" 画面；
// 2. 消除左下角“请检查浏览器插件”弹窗：拦截 /api/v0/telemetry 遥测上报请求，直接返回 200 OK，
//    避免被 uBlock Origin 等广告拦截插件拦截后连续失败 3 次触发 DeepSeek 的 adblockBanner；
// 3. 流式生成防抢滚：当用户主动向上滚动阅读上文时，阻止 DeepSeek 的自动吸底 scrollTo；
// 4. 全量静态渲染切换：保持滚动位置不跳动地触发 React 原生 virtual=false。

(() => {
  if (window.__dsToolkitMainWorldLoaded) return;
  window.__dsToolkitMainWorldLoaded = true;

  /* ------------------------------------------------------------------ */
  /* 1. React DOM 协调防崩溃护盾 (removeChild / insertBefore)             */
  /* ------------------------------------------------------------------ */

  const origRemoveChild = Node.prototype.removeChild;
  Node.prototype.removeChild = function (child) {
    if (child && child.parentNode !== this) {
      // 如果该子节点已被移动或不在当前父节点下，静默返回，绝不抛出 NotFoundError
      return child;
    }
    try {
      return origRemoveChild.call(this, child);
    } catch {
      return child;
    }
  };

  const origInsertBefore = Node.prototype.insertBefore;
  Node.prototype.insertBefore = function (newNode, referenceNode) {
    if (referenceNode && referenceNode.parentNode !== this) {
      // 如果参考节点不在当前父节点下，退化为 appendChild，绝不抛出 NotFoundError
      return this.appendChild(newNode);
    }
    try {
      return origInsertBefore.call(this, newNode, referenceNode);
    } catch {
      return this.appendChild(newNode);
    }
  };

  /* ------------------------------------------------------------------ */
  /* 2. 拦截 /api/v0/telemetry 遥测请求，消除左下角“请检查浏览器插件”警告  */
  /* ------------------------------------------------------------------ */

  function isTelemetryUrl(url) {
    if (!url) return false;
    const s = typeof url === "string" ? url : typeof url.url === "string" ? url.url : String(url);
    return s.includes("/api/v0/telemetry");
  }

  const origFetch = window.fetch;
  if (typeof origFetch === "function") {
    window.fetch = function (input, init) {
      try {
        if (isTelemetryUrl(input)) {
          return Promise.resolve(
            new Response('{"code":0,"msg":"","data":null}', {
              status: 200,
              headers: { "Content-Type": "application/json" }
            })
          );
        }
      } catch {
        // ignore
      }
      return origFetch.apply(this, arguments);
    };
  }

  /* ------------------------------------------------------------------ */
  /* 3. 流式生成时的「防抢滚」保护与原生全量静态渲染切换                   */
  /* ------------------------------------------------------------------ */

  let scrollGuardEnabled = true;
  let userReadingUp = false;
  let allowProgrammaticScrollUntil = 0;

  function isVirtualList(el) {
    return Boolean(el && el.classList && el.classList.contains("ds-virtual-list"));
  }

  function isAtBottom(el, threshold = 90) {
    if (!el) return true;
    return el.scrollHeight - el.scrollTop - el.clientHeight <= threshold;
  }

  window.addEventListener(
    "wheel",
    (e) => {
      const vl = e.target && e.target.closest ? e.target.closest(".ds-virtual-list") : null;
      if (!vl) return;
      if (e.deltaY < -2) {
        userReadingUp = true;
      } else if (e.deltaY > 2 && isAtBottom(vl, 110)) {
        userReadingUp = false;
      }
    },
    { passive: true, capture: true }
  );

  window.addEventListener(
    "scroll",
    (e) => {
      const vl = e.target;
      if (!isVirtualList(vl)) return;
      if (isAtBottom(vl, 64)) {
        userReadingUp = false;
      }
    },
    { passive: true, capture: true }
  );

  window.addEventListener(
    "click",
    (e) => {
      const t = e.target;
      if (!t || !t.closest) return;
      if (
        t.closest('[class*="scrollNav"]') ||
        t.closest(".ds-icon-button, .ds-button, button, a, [role='button']")
      ) {
        userReadingUp = false;
        allowProgrammaticScrollUntil = Date.now() + 700;
      }
    },
    true
  );

  window.addEventListener(
    "keydown",
    (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        userReadingUp = false;
        allowProgrammaticScrollUntil = Date.now() + 900;
      }
    },
    true
  );

  const nativeScrollTo = Element.prototype.scrollTo;
  if (typeof nativeScrollTo === "function") {
    Element.prototype.scrollTo = function (...args) {
      if (
        scrollGuardEnabled &&
        isVirtualList(this) &&
        userReadingUp &&
        Date.now() > allowProgrammaticScrollUntil &&
        !isAtBottom(this, 100)
      ) {
        const first = args[0];
        const targetTop = typeof first === "object" && first !== null ? first.top : args[1];
        if (typeof targetTop === "number" && targetTop > this.scrollTop + 4) {
          return;
        }
      }
      return nativeScrollTo.apply(this, args);
    };
  }

  window.addEventListener("dsv:config", (e) => {
    const detail = e.detail || {};
    if (typeof detail.scrollGuard === "boolean") {
      scrollGuardEnabled = detail.scrollGuard;
    }
  });

  window.addEventListener("dsv:disable-virtual", () => {
    const vl = document.querySelector(".ds-virtual-list");
    const prevTop = vl ? vl.scrollTop : null;
    const prevHeight = vl ? vl.scrollHeight : null;
    const wasBottom = vl ? isAtBottom(vl, 80) : false;

    allowProgrammaticScrollUntil = Date.now() + 300;
    window.dispatchEvent(new Event("beforeprint"));

    if (vl && prevTop !== null) {
      if (wasBottom) {
        vl.scrollTop = vl.scrollHeight;
      } else if (prevHeight && vl.scrollHeight !== prevHeight && prevTop > 0) {
        vl.scrollTop = prevTop;
      }
    }
  });
})();
