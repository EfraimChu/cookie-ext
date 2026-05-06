const SERVER_URL = "http://localhost:19222";
const TOKEN_HEADER = "X-Cert-Keeper-Token";

const DEFAULT_SETTINGS = {
  syncIntervalMinutes: 10,
  enforceWorkHours: true,
  workHours: { startMin: 570, endMin: 1140, weekdaysOnly: true },
  useNativeMessaging: false,
  authToken: "",
};

const DEFAULT_SITES = [
  { id: "datasuite", name: "DataSuite", url: "https://datasuite.shopee.io",
    cookies: true, localStorage: false, lsKeys: [], cookieValidation: "DATA-SUITE-AUTH-userToken" },
  { id: "wms-data", name: "WMS Data", url: "https://data.ssc.shopeemobile.com",
    cookies: true, localStorage: false, lsKeys: [], requiredCookies: ["csrfToken", "oa_user_id", "oa_skey"] },
  { id: "space", name: "SPACE", url: "https://space.shopee.io",
    cookies: true, localStorage: true, lsKeys: ["session"] },
];

const SITE_ICONS = {
  datasuite: { cls: "ds", emoji: "📊" },
  "wms-data": { cls: "wms", emoji: "🏭" },
  space: { cls: "sp", emoji: "🛰" },
};

let sites = [];
let settings = { ...DEFAULT_SETTINGS };

async function loadSettings() {
  const { settings: saved } = await chrome.storage.local.get("settings");
  settings = { ...DEFAULT_SETTINGS, ...(saved || {}) };
}

async function saveSettings() {
  await chrome.storage.local.set({ settings });
}


// ───────────────────────────────────────────────────────────────
// Sites
// ───────────────────────────────────────────────────────────────

async function loadSites() {
  const { sites: saved } = await chrome.storage.local.get("sites");
  sites = saved || [...DEFAULT_SITES];
  renderSites();
}

async function saveSites() {
  await chrome.storage.local.set({ sites });
}

function renderSites() {
  const el = document.getElementById("siteList");
  el.innerHTML = sites.map((s, i) => {
    const ic = SITE_ICONS[s.id] || { cls: "default", emoji: "🌐" };
    return `
    <div class="site" data-idx="${i}">
      <div class="site-row">
        <span class="site-name">
          <span class="site-icon ${ic.cls}">${ic.emoji}</span>${s.name}
        </span>
        <span class="site-del" data-idx="${i}">✕</span>
      </div>
      <div class="site-url">${s.url}</div>
      <div class="badges">
        ${s.cookies ? '<span class="badge badge-ck">🍪 cookies</span>' : ""}
        ${s.localStorage ? '<span class="badge badge-ls">📦 ' + s.lsKeys.join(", ") + "</span>" : ""}
      </div>
      <div class="site-status" id="status-${s.id}"></div>
    </div>`;
  }).join("");

  el.querySelectorAll(".site-del").forEach((b) =>
    b.addEventListener("click", async (e) => {
      sites.splice(+e.target.dataset.idx, 1);
      await saveSites();
      renderSites();
    })
  );

  el.addEventListener("click", async (e) => {
    const link = e.target.closest(".open-link");
    if (!link) return;
    e.preventDefault();
    const siteId = link.dataset.site;
    link.textContent = "⏳ 打开中…";
    try {
      await chrome.runtime.sendMessage({ action: "openAndSync", siteId });
      link.textContent = "✅ 已打开，登录后点「一键同步」";
    } catch (_) {
      link.textContent = "❌ 失败";
    }
  });
}

// ───────────────────────────────────────────────────────────────
// Sync
// ───────────────────────────────────────────────────────────────

async function getCookies(site) {
  const c = await chrome.cookies.getAll({ url: site.url });
  return c.map((x) => `${x.name}=${x.value}`).join("; ");
}

async function getLocalStorage(site) {
  if (!site.localStorage || !site.lsKeys?.length) return null;
  const origin = new URL(site.url).origin;
  const tabs = await chrome.tabs.query({ url: `${origin}/*` });
  if (!tabs.length) return null;
  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: tabs[0].id },
      func: (keys) => {
        const d = {};
        keys.forEach((k) => { const v = localStorage.getItem(k); if (v !== null) d[k] = v; });
        return d;
      },
      args: [site.lsKeys],
    });
    return result?.result || null;
  } catch (_) {
    return null;
  }
}

async function syncSite(site) {
  const st = document.getElementById(`status-${site.id}`);
  st.textContent = "⏳ 提取中…";
  st.className = "site-status loading show";

  try {
    const payload = { site_id: site.id, name: site.name, url: site.url };
    if (site.cookies) payload.cookies = await getCookies(site);
    if (site.localStorage) payload.localStorage = await getLocalStorage(site);

    const hasAuth = !site.cookieValidation ||
      (payload.cookies && payload.cookies.includes(site.cookieValidation));

    // Check required cookies
    let missingRequired = [];
    if (site.requiredCookies?.length && payload.cookies) {
      const cookieNames = new Set(payload.cookies.split("; ").map((p) => p.split("=")[0]));
      missingRequired = site.requiredCookies.filter((k) => !cookieNames.has(k));
    }

    const headers = { "Content-Type": "application/json" };
    if (settings.authToken) headers[TOKEN_HEADER] = settings.authToken;
    const resp = await fetch(`${SERVER_URL}/save`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });

    if (resp.ok) {
      const n = payload.cookies ? payload.cookies.split("; ").length : 0;
      const ls = payload.localStorage ? Object.keys(payload.localStorage).length : 0;
      let msg = `✅ ${n} cookies`;
      if (ls) msg += ` · ${ls} ls keys`;
      if (site.cookieValidation && !hasAuth) msg += " ⚠ 缺 auth";
      if (missingRequired.length) msg += ` ⚠ 缺 ${missingRequired.join(", ")}`;
      const isWarn = (site.cookieValidation && !hasAuth) || missingRequired.length;
      st.className = `site-status show ${isWarn ? "warn" : "ok"}`;
      if (missingRequired.length || (site.cookieValidation && !hasAuth)) {
        st.innerHTML = `${msg} <a href="#" class="open-link" data-site="${site.id}">打开登录</a>`;
      } else {
        st.textContent = msg;
      }
      return !missingRequired.length;
    }
    st.textContent = `❌ server ${resp.status}`;
    st.className = "site-status err show";
    return false;
  } catch (e) {
    st.textContent = e.message.includes("fetch")
      ? "❌ 服务未启动 → refresh-cookie" : `❌ ${e.message}`;
    st.className = "site-status err show";
    return false;
  }
}

document.getElementById("btnSync").addEventListener("click", async () => {
  const btn = document.getElementById("btnSync");
  btn.textContent = "⏳ 同步中…";
  btn.disabled = true;
  let ok = 0, fail = 0;
  for (const s of sites) { (await syncSite(s)) ? ok++ : fail++; }
  btn.textContent = "⬆ 一键同步";
  btn.disabled = false;
  const st = document.getElementById("status");
  st.textContent = fail ? `⚠ ${ok} 成功, ${fail} 失败` : `✅ 全部成功 (${ok})`;
  st.className = fail ? "status-err" : "status-ok";
  setTimeout(() => { st.style.display = "none"; }, 3000);
});

// ───────────────────────────────────────────────────────────────
// Add Site
// ───────────────────────────────────────────────────────────────

const addForm = document.getElementById("addForm");
document.getElementById("btnToggleAdd").addEventListener("click", () => addForm.classList.toggle("show"));
document.getElementById("btnAddCancel").addEventListener("click", () => addForm.classList.remove("show"));
document.getElementById("addLs").addEventListener("change", (e) => {
  document.getElementById("addLsKeys").disabled = !e.target.checked;
});

document.getElementById("btnAddSave").addEventListener("click", async () => {
  const name = document.getElementById("addName").value.trim();
  const url = document.getElementById("addUrl").value.trim();
  if (!name || !url) return alert("名称和 URL 不能为空");
  const id = name.toLowerCase().replace(/[^a-z0-9]/g, "-");
  sites.push({
    id, name, url,
    cookies: document.getElementById("addCookies").checked,
    localStorage: document.getElementById("addLs").checked,
    lsKeys: document.getElementById("addLsKeys").value.split(",").map((s) => s.trim()).filter(Boolean),
  });
  await saveSites();
  renderSites();
  ["addName", "addUrl", "addLsKeys"].forEach((x) => (document.getElementById(x).value = ""));
  document.getElementById("addCookies").checked = true;
  document.getElementById("addLs").checked = false;
  document.getElementById("addLsKeys").disabled = true;
  addForm.classList.remove("show");
});

// ───────────────────────────────────────────────────────────────
// Current Tab Detection
// ───────────────────────────────────────────────────────────────

async function detectTab() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url) return;
    const u = new URL(tab.url);
    const match = sites.find((s) => new URL(s.url).hostname === u.hostname);
    if (match) {
      const el = document.querySelector(`.site[data-idx="${sites.indexOf(match)}"]`);
      if (el) { el.style.borderColor = "#0071e3"; el.style.boxShadow = "0 0 0 2px rgba(0,113,227,.12)"; }
      const st = document.getElementById(`status-${match.id}`);
      if (st && !st.classList.contains("show")) {
        st.textContent = "📍 当前站点";
        st.className = "site-status loading show";
      }
    } else if (u.protocol === "https:") {
      const b = document.createElement("div");
      b.style.cssText = "margin:0 16px 6px;padding:10px 12px;background:#fff;border:1px dashed #0071e3;border-radius:10px;font-size:12px;cursor:pointer;display:flex;align-items:center;gap:8px;transition:background .15s";
      b.innerHTML = `<span style="font-size:15px">🌐</span><div><b style="color:#0071e3">检测到: ${u.hostname}</b><br><span style="color:#8e8e93;font-size:10px">点击快速添加</span></div>`;
      b.onmouseenter = () => (b.style.background = "#f0f4ff");
      b.onmouseleave = () => (b.style.background = "#fff");
      b.onclick = () => {
        document.getElementById("addName").value = u.hostname.split(".")[0];
        document.getElementById("addUrl").value = u.origin;
        addForm.classList.add("show");
        b.remove();
      };
      document.getElementById("siteList").before(b);
    }
  } catch (_) {}
}

// ───────────────────────────────────────────────────────────────
// Recording Controls
// ───────────────────────────────────────────────────────────────

const btnRecord = document.getElementById("btnRecord");
const btnViewRec = document.getElementById("btnViewRec");
const recBar = document.getElementById("recBar");
const recDot = document.getElementById("recDot");
const recLabel = document.getElementById("recLabel");
const recCount = document.getElementById("recCount");
let pollTimer = null;

function setRecUI(active, count) {
  if (active) {
    btnRecord.textContent = "■ STOP";
    btnRecord.classList.add("on");
    recBar.classList.add("show");
    recDot.classList.add("on");
    recDot.classList.remove("idle");
    recLabel.textContent = "录制中";
    recCount.textContent = count;
    recCount.classList.remove("idle");
    if (!pollTimer) {
      pollTimer = setInterval(async () => {
        try {
          const s = await chrome.runtime.sendMessage({ action: "getRecordingState" });
          recCount.textContent = s.count;
        } catch (_) {}
      }, 800);
    }
  } else {
    btnRecord.textContent = "● REC";
    btnRecord.classList.remove("on");
    recDot.classList.remove("on");
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    if (count > 0) {
      recBar.classList.add("show");
      recDot.classList.add("idle");
      recLabel.textContent = "已捕获";
      recCount.textContent = count;
      recCount.classList.add("idle");
    }
  }
}

btnRecord.addEventListener("click", async () => {
  try {
    const state = await chrome.runtime.sendMessage({ action: "getRecordingState" });
    if (state.active) {
      const result = await chrome.runtime.sendMessage({ action: "stopRecording" });
      if (result?.ok) {
        setRecUI(false, result.count);
      } else {
        recLabel.textContent = "⚠ 停止失败";
      }
    } else {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) { recLabel.textContent = "⚠ 无活动标签"; return; }
      const result = await chrome.runtime.sendMessage({ action: "startRecording", tabId: tab.id });
      if (result?.ok) {
        setRecUI(true, 0);
      } else {
        recBar.classList.add("show");
        recLabel.textContent = "⚠ 启动失败";
      }
    }
  } catch (e) {
    recBar.classList.add("show");
    recDot.classList.add("idle");
    recLabel.textContent = "⚠ 通信失败，请重新加载扩展";
  }
});

btnViewRec.addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("recorder.html") });
});

// ───────────────────────────────────────────────────────────────
// Auto Sync Hint
// ───────────────────────────────────────────────────────────────

async function showSyncHint() {
  try {
    const info = await chrome.runtime.sendMessage({ action: "getAutoSyncInfo" });
    if (info?.timeStr) {
      document.getElementById("autoSyncHint").textContent =
        `⏰ 自动同步 · 上次 ${info.timeStr} (${info.synced}/${info.total})`;
    }
  } catch (_) {}
}

// ───────────────────────────────────────────────────────────────
// Init
// ───────────────────────────────────────────────────────────────

// ───────────────────────────────────────────────────────────────
// Settings UI
// ───────────────────────────────────────────────────────────────

function bindSettingsUI() {
  const body = document.getElementById("settingsBody");
  const caret = document.getElementById("settingsCaret");
  document.getElementById("settingsToggle").addEventListener("click", () => {
    const open = body.style.display === "block";
    body.style.display = open ? "none" : "block";
    caret.textContent = open ? "▾" : "▴";
  });

  document.getElementById("setEnforceWH").checked = !!settings.enforceWorkHours;
  document.getElementById("setInterval").value = settings.syncIntervalMinutes;
  document.getElementById("setNative").checked = !!settings.useNativeMessaging;
  document.getElementById("setToken").value = settings.authToken || "";

  document.getElementById("btnSettingsSave").addEventListener("click", async () => {
    settings.enforceWorkHours = document.getElementById("setEnforceWH").checked;
    settings.syncIntervalMinutes = Math.max(1, Math.min(60, +document.getElementById("setInterval").value || 10));
    settings.useNativeMessaging = document.getElementById("setNative").checked;
    settings.authToken = document.getElementById("setToken").value.trim();
    await saveSettings();
    document.getElementById("settingsHint").textContent = "✅ 已保存";
    setTimeout(() => { document.getElementById("settingsHint").textContent = ""; }, 1500);
  });

  document.getElementById("btnFlushPending").addEventListener("click", async () => {
    const r = await chrome.runtime.sendMessage({ action: "flushPending" });
    document.getElementById("settingsHint").textContent =
      `重传完成: 成功 ${r?.flushed ?? 0}, 仍未送达 ${r?.remaining ?? 0}`;
  });
}

(async () => {
  await loadSettings();
  await loadSites();
  bindSettingsUI();
  detectTab();
  try {
    const state = await chrome.runtime.sendMessage({ action: "getRecordingState" });
    setRecUI(state.active, state.count);
  } catch (_) {
    setRecUI(false, 0);
  }
  showSyncHint();
})();

