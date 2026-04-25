// Cert Keeper background service worker (MV3, ES module).
//
// Responsibilities:
//   * Periodically (and on cookie change) collect cookies / localStorage for
//     each configured site and forward them to the local server.
//   * Buffer payloads in `pendingSync` storage when the server is unreachable
//     and replay them on the next opportunity.
//   * Capture XHR/Fetch traffic for the API recorder.
//
// Two server transports are supported:
//   * HTTP  POST  http://localhost:19222/save  (default; needs auth token)
//   * Native Messaging via `chrome.runtime.connectNative`
//     (needs a one-time `cert-keeper install-native-host` step)

import {
  DEFAULT_SETTINGS,
  DEFAULT_SITES,
  NATIVE_HOST,
  SERVER_URL,
  TOKEN_HEADER,
} from "./config.js";

// ───────────────────────────────────────────────────────────────
// Settings
// ───────────────────────────────────────────────────────────────

async function loadSettings() {
  const { settings } = await chrome.storage.local.get("settings");
  return { ...DEFAULT_SETTINGS, ...(settings || {}) };
}

async function loadSites() {
  const { sites } = await chrome.storage.local.get("sites");
  return sites?.length ? sites : DEFAULT_SITES;
}

function isWorkHours(settings) {
  if (!settings.enforceWorkHours) return true;
  const wh = settings.workHours || DEFAULT_SETTINGS.workHours;
  const now = new Date();
  if (wh.weekdaysOnly) {
    const day = now.getDay();
    if (day === 0 || day === 6) return false;
  }
  const mins = now.getHours() * 60 + now.getMinutes();
  return mins >= wh.startMin && mins <= wh.endMin;
}

// ───────────────────────────────────────────────────────────────
// Alarm setup — re-applied whenever the settings change.
// ───────────────────────────────────────────────────────────────

async function rescheduleAlarm() {
  const { syncIntervalMinutes } = await loadSettings();
  const minutes = Math.max(1, Math.min(60, Number(syncIntervalMinutes) || 30));
  await chrome.alarms.clear("auto-sync");
  chrome.alarms.create("auto-sync", { periodInMinutes: minutes, delayInMinutes: 1 });
}

chrome.runtime.onInstalled.addListener(() => { rescheduleAlarm(); });
chrome.runtime.onStartup.addListener(() => { rescheduleAlarm(); flushPendingSync(); });

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "auto-sync") autoSync().catch((e) => console.warn("[autoSync]", e));
});

// ───────────────────────────────────────────────────────────────
// Cookie change watcher — debounced per-site sync.
// Ensures we capture freshly minted login cookies without waiting up to
// `syncIntervalMinutes` for the next alarm tick.
// ───────────────────────────────────────────────────────────────

const cookieDebounce = new Map(); // siteId -> timeoutId

chrome.cookies.onChanged.addListener(async ({ cookie, removed }) => {
  if (removed) return;
  const sites = await loadSites();
  for (const site of sites) {
    const watch = [...(site.requiredCookies || []), site.cookieValidation].filter(Boolean);
    if (!watch.includes(cookie.name)) continue;
    let host;
    try { host = new URL(site.url).hostname; } catch { continue; }
    const cookieDomain = (cookie.domain || "").replace(/^\./, "");
    if (!host.endsWith(cookieDomain)) continue;

    if (cookieDebounce.has(site.id)) clearTimeout(cookieDebounce.get(site.id));
    cookieDebounce.set(site.id, setTimeout(() => {
      cookieDebounce.delete(site.id);
      syncOne(site).catch((e) => console.warn(`[sync ${site.id}]`, e));
    }, 8000));
    break;
  }
});

// ───────────────────────────────────────────────────────────────
// Payload construction
// ───────────────────────────────────────────────────────────────

async function buildPayload(site) {
  const payload = { site_id: site.id, name: site.name, url: site.url };

  if (site.cookies) {
    const cookies = await chrome.cookies.getAll({ url: site.url });
    payload.cookies = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    payload.cookies_detail = cookies.map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path,
      secure: c.secure,
      httpOnly: c.httpOnly,
      sameSite: c.sameSite,
      expirationDate: c.expirationDate,
      hostOnly: c.hostOnly,
    }));
    if (site.requiredCookies?.length) {
      const names = new Set(cookies.map((c) => c.name));
      const missing = site.requiredCookies.filter((k) => !names.has(k));
      if (missing.length) payload.missingCookies = missing;
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
    } catch (_) { /* tab gone or no permission – fine */ }
  }

  return payload;
}

// ───────────────────────────────────────────────────────────────
// Transport: HTTP + Native Messaging
// ───────────────────────────────────────────────────────────────

async function sendNative(action, payload) {
  return new Promise((resolve, reject) => {
    let port;
    try {
      port = chrome.runtime.connectNative(NATIVE_HOST);
    } catch (e) { reject(e); return; }
    const timer = setTimeout(() => { try { port.disconnect(); } catch (_) {} reject(new Error("native host timeout")); }, 10000);
    port.onMessage.addListener((msg) => {
      clearTimeout(timer);
      try { port.disconnect(); } catch (_) {}
      msg?.ok ? resolve(msg) : reject(new Error(msg?.error || "native host error"));
    });
    port.onDisconnect.addListener(() => {
      clearTimeout(timer);
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(err.message));
    });
    port.postMessage({ action, payload });
  });
}

async function sendHttp(path, payload, settings) {
  const headers = { "Content-Type": "application/json" };
  if (settings.authToken) headers[TOKEN_HEADER] = settings.authToken;
  const r = await fetch(`${SERVER_URL}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });
  if (!r.ok) throw new Error(`server ${r.status}`);
  return r.json().catch(() => ({}));
}

async function deliver(payload, settings) {
  if (settings.useNativeMessaging) {
    try { return await sendNative("save", payload); }
    catch (e) { console.warn("[nativeMessaging] falling back to HTTP:", e.message); }
  }
  return sendHttp("/save", payload, settings);
}

// ───────────────────────────────────────────────────────────────
// pendingSync queue — replay payloads that failed to deliver.
// ───────────────────────────────────────────────────────────────

async function queuePending(payload) {
  const { pendingSync = {} } = await chrome.storage.local.get("pendingSync");
  pendingSync[payload.site_id] = { payload, queuedAt: Date.now() };
  await chrome.storage.local.set({ pendingSync });
}

async function flushPendingSync() {
  const { pendingSync = {} } = await chrome.storage.local.get("pendingSync");
  const ids = Object.keys(pendingSync);
  if (!ids.length) return { flushed: 0, remaining: 0 };

  const settings = await loadSettings();
  let flushed = 0;
  const remaining = {};
  for (const id of ids) {
    try {
      await deliver(pendingSync[id].payload, settings);
      flushed++;
    } catch (_) {
      remaining[id] = pendingSync[id];
    }
  }
  await chrome.storage.local.set({ pendingSync: remaining });
  return { flushed, remaining: Object.keys(remaining).length };
}

// ───────────────────────────────────────────────────────────────
// autoSync — runs on alarm, on startup, and on user request.
// Reentrant calls are coalesced via `syncLock`.
// ───────────────────────────────────────────────────────────────

let syncLock = null;

async function syncOne(site, settings) {
  settings ||= await loadSettings();
  let payload;
  try { payload = await buildPayload(site); }
  catch (e) { return { ok: false, site: site.id, error: e.message }; }

  if (payload.missingCookies?.length) {
    autoOpenAndResync(site, payload.missingCookies, settings)
      .catch((e) => console.warn("[autoOpen]", e));
  }

  try {
    await deliver(payload, settings);
    await clearPending(site.id);
    return { ok: true, site: site.id };
  } catch (e) {
    await queuePending(payload);
    return { ok: false, site: site.id, error: e.message };
  }
}

async function clearPending(siteId) {
  const { pendingSync = {} } = await chrome.storage.local.get("pendingSync");
  if (siteId in pendingSync) {
    delete pendingSync[siteId];
    await chrome.storage.local.set({ pendingSync });
  }
}

async function autoSync(force = false) {
  if (syncLock) return syncLock;
  syncLock = (async () => {
    const settings = await loadSettings();
    if (!force && !isWorkHours(settings)) return { skipped: "outside work hours" };

    const sites = await loadSites();
    const results = [];
    for (const site of sites) results.push(await syncOne(site, settings));
    await flushPendingSync();

    const ok = results.filter((r) => r.ok).length;
    const errors = results.filter((r) => !r.ok);
    const ts = new Date().toLocaleTimeString("zh-CN", { hour12: false });
    await chrome.storage.local.set({
      lastAutoSync: {
        time: Date.now(), timeStr: ts,
        synced: ok, total: sites.length,
        errors: errors.reduce((m, r) => { m[r.site] = r.error; return m; }, {}),
      },
    });
    return { ok, total: sites.length, errors };
  })().finally(() => { syncLock = null; });
  return syncLock;
}

// ───────────────────────────────────────────────────────────────
// Auto Open & Resync — open site tab when cookies are expired/missing
// ───────────────────────────────────────────────────────────────

async function autoOpenAndResync(site, missing, settings) {
  const origin = new URL(site.url).origin;
  let tabs = await chrome.tabs.query({ url: `${origin}/*` });
  if (!tabs.length) {
    const tab = await chrome.tabs.create({ url: site.url, active: false });
    tabs = [tab];
  } else {
    await chrome.tabs.reload(tabs[0].id);
  }

  const tabId = tabs[0].id;
  const onDone = async () => {
    const payload = await buildPayload(site);
    if (payload.missingCookies?.length) return; // still missing, give up this round
    try { await deliver(payload, settings); await clearPending(site.id); }
    catch (e) { await queuePending(payload); console.warn(`[resync ${site.id}]`, e.message); }
  };

  const timeout = setTimeout(() => { chrome.tabs.onUpdated.removeListener(listener); }, 60000);
  function listener(id, info) {
    if (id === tabId && info.status === "complete") {
      clearTimeout(timeout);
      chrome.tabs.onUpdated.removeListener(listener);
      setTimeout(onDone, 5000);
    }
  }
  chrome.tabs.onUpdated.addListener(listener);
}

async function openAndSync(siteId) {
  const sites = await loadSites();
  const site = sites.find((s) => s.id === siteId);
  if (!site) return { ok: false, error: "Site not found" };
  const origin = new URL(site.url).origin;
  let tabs = await chrome.tabs.query({ url: `${origin}/*` });
  if (!tabs.length) {
    await chrome.tabs.create({ url: site.url, active: true });
  } else {
    await chrome.tabs.update(tabs[0].id, { active: true });
    await chrome.tabs.reload(tabs[0].id);
  }
  return { ok: true, message: `Opened ${site.url}. Will resync after page loads.` };
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
// Settings change listener — re-arm the alarm if the interval changed.
// ───────────────────────────────────────────────────────────────

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes.settings) return;
  rescheduleAlarm();
});

// ───────────────────────────────────────────────────────────────
// Message Handling — sync replies for state, async for data ops
// ───────────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  switch (msg.action) {
    case "startRecording":
      rec = { active: true, tabId: msg.tabId, pending: {}, done: [] };
      Promise.all([
        chrome.scripting.executeScript({
          target: { tabId: msg.tabId }, files: ["interceptor_bridge.js"],
        }),
        chrome.scripting.executeScript({
          target: { tabId: msg.tabId }, files: ["interceptor.js"], world: "MAIN",
        }),
      ]).catch(() => {});
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

    case "clearRecording":
      rec.done = [];
      rec.pending = {};
      Promise.all([
        chrome.storage.local.remove("lastRecording"),
        saveRecState(),
      ])
        .then(() => sendResponse({ ok: true }))
        .catch((e) => sendResponse({ ok: false, error: e.message }));
      return true;

    case "getAutoSyncInfo":
      chrome.storage.local.get("lastAutoSync").then(({ lastAutoSync }) => {
        sendResponse(lastAutoSync || null);
      });
      return true;

    case "triggerSync":
      autoSync(true).then((r) => sendResponse({ ok: true, ...r }));
      return true;

    case "flushPending":
      flushPendingSync().then((r) => sendResponse({ ok: true, ...r }));
      return true;

    case "responseBody": {
      if (!rec.active) break;
      const { url, status, body } = msg;
      for (let i = rec.done.length - 1; i >= 0; i--) {
        if (rec.done[i].url === url && !rec.done[i].responseBody) {
          rec.done[i].responseBody = body;
          break;
        }
      }
      for (const [, p] of Object.entries(rec.pending)) {
        if (p.url === url && !p.responseBody) {
          p.responseBody = body;
          break;
        }
      }
      sendResponse({ ok: true });
      return false;
    }

    case "openAndSync":
      openAndSync(msg.siteId)
        .then((r) => sendResponse(r))
        .catch((e) => sendResponse({ ok: false, error: e.message }));
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

// Make sure the alarm exists even if the SW was just spun up by an event
// other than onInstalled / onStartup.
rescheduleAlarm();
