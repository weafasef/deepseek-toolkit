// popup.js —— DeepSeek 网页增强面板 (v1.4)

(() => {
  const DEFAULTS = {
    staticRender: true,
    scrollGuard: true,
    pageWidth: "wide",
    showTopBar: true,
    collapseDefault: true,
    autoCollapseOnDone: true,
    rememberState: true,
    latexConvert: true,
    latexCopy: true,
    copyWithDelimiters: true
  };

  let settings = { ...DEFAULTS };
  let activeTab = null;

  const statusDot = document.getElementById("statusDot");
  const statBar = document.getElementById("statBar");
  const inputs = Array.from(document.querySelectorAll("input[data-key]"));
  const collapseAllBtn = document.getElementById("collapseAllBtn");
  const expandAllBtn = document.getElementById("expandAllBtn");

  function isDeepSeekTab(tab) {
    try {
      const u = new URL(tab?.url || "");
      return u.hostname === "chat.deepseek.com";
    } catch {
      return false;
    }
  }

  function render() {
    for (const input of inputs) {
      input.checked = Boolean(settings[input.dataset.key]);
    }
    const copyOn = Boolean(settings.latexCopy);
    const delimInput = document.querySelector('input[data-key="copyWithDelimiters"]');
    if (delimInput) {
      delimInput.disabled = !copyOn;
      delimInput.closest(".rule-row").style.opacity = copyOn ? "1" : "0.5";
    }
  }

  function save() {
    chrome.storage.local.set({ dsToolkitSettings: settings });
  }

  function sendToTab(payload) {
    return new Promise((resolve) => {
      if (!activeTab?.id) return resolve({ ok: false });
      chrome.tabs.sendMessage(activeTab.id, payload, (res) => {
        if (chrome.runtime.lastError) return resolve({ ok: false, error: chrome.runtime.lastError.message });
        resolve(res || { ok: false });
      });
    });
  }

  async function refreshStatus() {
    if (!isDeepSeekTab(activeTab)) {
      statusDot.classList.remove("on");
      statBar.textContent = "当前页不是 chat.deepseek.com，打开对话页后生效";
      collapseAllBtn.disabled = true;
      expandAllBtn.disabled = true;
      return;
    }
    statusDot.classList.add("on");
    collapseAllBtn.disabled = false;
    expandAllBtn.disabled = false;
    const res = await sendToTab({ type: "DSV_STATUS" });
    if (!res?.ok) {
      statBar.textContent = "已就绪，刷新一下 DeepSeek 页面即可生效";
      return;
    }
    const modeStr = res.staticActive ? `全量渲染 ${res.msgCount || 0} 条消息` : "原生列表";
    statBar.textContent = `${modeStr} · 思维链 ${res.thinkCount} 个（展开 ${res.openCount}）· 兼容公式 ${res.mathCount} 个`;
  }

  for (const input of inputs) {
    input.addEventListener("change", () => {
      settings[input.dataset.key] = input.checked;
      save();
      render();
    });
  }

  collapseAllBtn.addEventListener("click", async () => {
    const res = await sendToTab({ type: "DSV_SET_ALL", open: false });
    if (res?.ok) statBar.textContent = `已折叠 ${res.count} 个思维链块`;
    else statBar.textContent = "操作失败，请刷新 DeepSeek 页面后重试";
  });

  expandAllBtn.addEventListener("click", async () => {
    const res = await sendToTab({ type: "DSV_SET_ALL", open: true });
    if (res?.ok) statBar.textContent = `已展开 ${res.count} 个思维链块`;
    else statBar.textContent = "操作失败，请刷新 DeepSeek 页面后重试";
  });

  (async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    activeTab = tab || null;

    const stored = await chrome.storage.local.get("dsToolkitSettings");
    if (stored?.dsToolkitSettings) {
      settings = { ...DEFAULTS, ...stored.dsToolkitSettings };
    } else {
      chrome.storage.local.set({ dsToolkitSettings: settings });
    }

    render();
    refreshStatus();
  })();
})();
