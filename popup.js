// popup.js —— DeepSeek 网页增强面板

(() => {
  const DEFAULTS = {
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
  const openReaderBtn = document.getElementById("openReaderBtn");

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
    // 关了“复制源码”就不用再显示定界符开关的语义
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
      statBar.textContent = "已注入，刷新一下页面后即可统计";
      return;
    }
    statBar.textContent = `本页识别到 ${res.thinkCount} 个思维链块（展开 ${res.openCount} 个）· 插件渲染了 ${res.mathCount} 个公式`;
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

  openReaderBtn.addEventListener("click", async () => {
    if (!isDeepSeekTab(activeTab)) {
      statBar.textContent = "请先打开 chat.deepseek.com 的对话页";
      return;
    }
    const res = await sendToTab({ type: "DSV_OPEN_READER" });
    if (res?.ok) {
      window.close();
    } else {
      statBar.textContent = "打开失败，请刷新 DeepSeek 页面后重试";
    }
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
