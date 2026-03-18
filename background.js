const SERVER_URL = "http://localhost:19222";

const DEFAULT_SITES = [
  { id: "datasuite", name: "DataSuite", url: "https://datasuite.shopee.io", cookies: true, localStorage: false, lsKeys: [] },
  { id: "wms-data", name: "WMS Data", url: "https://data.ssc.shopeemobile.com", cookies: true, localStorage: false, lsKeys: [], requiredCookies: ["csrfToken", "oa_user_id", "oa_skey"] },
  { id: "space", name: "SPACE", url: "https://space.shopee.io", cookies: true, localStorage: true, lsKeys: ["session"] },
];

// ───────────────────────────────────────────────────────────────
// Auto Sync — every 30 min during work hours (Mon–Fri 9:30–19:00)
// ───────────────────────────────────────────────────────────────

chrome.alarms.create("auto-sync", { periodInMinutes: 30 });

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "auto-sync") autoSync();
});

function isWorkHours() {
  const now = new Date();
  const day = now.getDay();
  if (day === 0 || day === 6) return false;
  const mins = now.getHours() * 60 + now.getMinutes();
  return mins >= 570 && mins <= 1140;
}

async function autoSync() {
  if (!isWorkHours()) return;
  const { sites } = await chrome.storage.local.get("sites");
  const list = sites || DEFAULT_SITES;
  let ok = 0;

  for (const site of list) {
    const payload = { site_id: site.id, name: site.name, url: site.url };

    if (site.cookies) {
      const cookies = await chrome.cookies.getAll({ url: site.url });
      const cookieNames = new Set(cookies.map((c) => c.name));
      payload.cookies = cookies.map((c) => `${c.name}=${c.value}`).join("; ");

      if (site.requiredCookies?.length) {
        const missing = site.requiredCookies.filter((k) => !cookieNames.has(k));
        if (missing.length) {
          payload.missingCookies = missing;
          console.warn(`[${site.id}] Missing required cookies: ${missing.join(", ")}. Visit ${site.url} first.`);
        }
      }
    }

    if (site.localStorage && site.lsKeys?.length) {
      try {
        const origin = new URL(site.url).origin;
        const tabs = await chrome.tabs.query({ url: `${origin}/*` });
        if (tabs.length) {
          const [result] = await chrome.scripting.executeScript({
            target: { tabId: tabs[0].id },
            func: (keys) => {
              const d = {};
              keys.forEach((k) => { const v = localStorage.getItem(k); if (v !== null) d[k] = v; });
              return d;
            },
            args: [site.lsKeys],
          });
          payload.localStorage = result?.result || null;
        }
      } catch (_) {}
    }

    try {
      const r = await fetch(`${SERVER_URL}/save`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (r.ok) ok++;
    } catch (_) {
      const { pendingSync = {} } = await chrome.storage.local.get("pendingSync");
      pendingSync[site.id] = payload;
      await chrome.storage.local.set({ pendingSync });
    }
  }

  const ts = new Date().toLocaleTimeString("zh-CN", { hour12: false });
  await chrome.storage.local.set({
    lastAutoSync: { time: Date.now(), timeStr: ts, synced: ok, total: list.length },
  });
}

// ───────────────────────────────────────────────────────────────
// API Recording — uses webRequest to capture XHR/Fetch
// State is persisted to storage so it survives SW restarts.
// ───────────────────────────────────────────────────────────────

let rec = { active: false, tabId: null, pending: {}, done: [] };

async function loadRecState() {
  const { recState } = await chrome.storage.session.get("recState");
  if (recState) {
    rec.active = recState.active;
    rec.tabId = recState.tabId;
    rec.done = recState.done || [];
  }
}

async function saveRecState() {
  await chrome.storage.session.set({
    recState: { active: rec.active, tabId: rec.tabId, done: rec.done },
  });
}

loadRecState();

chrome.webRequest.onBeforeRequest.addListener(
  (d) => {
    if (!rec.active || d.tabId !== rec.tabId) return;
    if (d.type !== "xmlhttprequest") return;

    let body = null;
    if (d.requestBody?.raw) {
      body = d.requestBody.raw
        .filter((r) => r.bytes)
        .map((r) => new TextDecoder().decode(r.bytes))
        .join("");
    } else if (d.requestBody?.formData) {
      body = JSON.stringify(d.requestBody.formData);
    }

    rec.pending[d.requestId] = {
      id: d.requestId,
      url: d.url,
      method: d.method,
      timestamp: d.timeStamp,
      requestBody: body,
    };
  },
  { urls: ["<all_urls>"] },
  ["requestBody"]
);

chrome.webRequest.onSendHeaders.addListener(
  (d) => {
    if (!rec.active) return;
    const r = rec.pending[d.requestId];
    if (r) r.requestHeaders = d.requestHeaders;
  },
  { urls: ["<all_urls>"] },
  ["requestHeaders", "extraHeaders"]
);

chrome.webRequest.onCompleted.addListener(
  (d) => {
    if (!rec.active) return;
    const r = rec.pending[d.requestId];
    if (!r) return;
    r.statusCode = d.statusCode;
    r.statusLine = d.statusLine;
    r.responseHeaders = d.responseHeaders;
    r.duration = d.timeStamp - r.timestamp;
    rec.done.push(r);
    delete rec.pending[d.requestId];
    saveRecState();
  },
  { urls: ["<all_urls>"] },
  ["responseHeaders", "extraHeaders"]
);

chrome.webRequest.onErrorOccurred.addListener(
  (d) => {
    if (!rec.active) return;
    const r = rec.pending[d.requestId];
    if (!r) return;
    r.error = d.error;
    r.statusCode = 0;
    r.duration = d.timeStamp - r.timestamp;
    rec.done.push(r);
    delete rec.pending[d.requestId];
    saveRecState();
  },
  { urls: ["<all_urls>"] }
);

// ───────────────────────────────────────────────────────────────
// Message Handling — sync replies for state, async for data ops
// ───────────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  switch (msg.action) {
    case "startRecording":
      rec = { active: true, tabId: msg.tabId, pending: {}, done: [] };
      saveRecState()
        .then(() => sendResponse({ ok: true }))
        .catch((e) => sendResponse({ ok: false, error: e.message }));
      return true;

    case "stopRecording": {
      rec.active = false;
      const stopped = [...rec.done];
      Promise.all([
        chrome.storage.local.set({ lastRecording: stopped }),
        saveRecState(),
      ])
        .then(() => sendResponse({ ok: true, count: stopped.length }))
        .catch((e) => sendResponse({ ok: false, count: stopped.length, error: e.message }));
      return true;
    }

    case "getRecordingState":
      sendResponse({ active: rec.active, tabId: rec.tabId, count: rec.done.length });
      return false;

    case "getRecording":
      sendResponse({ requests: [...rec.done] });
      return false;

    case "getAutoSyncInfo":
      chrome.storage.local.get("lastAutoSync").then(({ lastAutoSync }) => {
        sendResponse(lastAutoSync || null);
      });
      return true;

    case "triggerSync":
      autoSync().then(() => sendResponse({ ok: true }));
      return true;

    case "fetchResponse": {
      const { url, method, headers, body } = msg;
      const opts = { method: method || "GET", headers: headers || {} };
      if (body && method !== "GET" && method !== "HEAD") opts.body = body;
      fetch(url, opts)
        .then(async (r) => {
          let text = "";
          try { text = await r.text(); } catch (_) {}
          sendResponse({ ok: true, status: r.status, body: text });
        })
        .catch((e) => sendResponse({ ok: false, error: e.message }));
      return true;
    }

    default:
      sendResponse({ error: "unknown action" });
      return false;
  }
});
