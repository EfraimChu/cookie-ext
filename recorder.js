const SERVER_URL = "http://localhost:19222";
let requests = [];
let filterMethod = "ALL";
let filterText = "";
let filterDomain = "";
let selected = new Set();
let hideNoise = true;
let groupMode = "none"; // "none" | "domain" | "time"

const NOISE_PATTERNS = [
  /google-analytics\.com/, /googletagmanager\.com/, /analytics\./,
  /sentry\.io/, /hotjar\.com/, /mixpanel\.com/, /segment\.com/,
  /doubleclick\.net/, /facebook\.net/, /fbevents/, /pixel/,
  /beacon/, /tracking/, /telemetry/, /collect\?/, /rum\./,
  /clarity\.ms/, /newrelic\.com/, /datadoghq\.com/,
  /\.png$/, /\.jpg$/, /\.gif$/, /\.svg$/, /\.ico$/, /\.woff/,
  /\.css$/, /\.js\?/, /fonts\.googleapis/, /cdn\.jsdelivr/,
];

// ───────────────────────────────────────────────────────────────
// Data Loading
// ───────────────────────────────────────────────────────────────

async function load() {
  try {
    const r = await chrome.runtime.sendMessage({ action: "getRecording" });
    if (r?.requests?.length) requests = r.requests;
  } catch (_) {}
  if (!requests.length) {
    const { lastRecording } = await chrome.storage.local.get("lastRecording");
    if (lastRecording?.length) requests = lastRecording;
  }
  renderDomainChips();
  render();
}

// ───────────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────────

const esc = (s) =>
  s ? String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;") : "";

const safeUrl = (s) => { try { return new URL(s); } catch (_) { return null; } };

function scCls(c) { return c ? `sc-${Math.floor(c / 100)}` : "sc-0"; }
function fmtMs(ms) { return ms == null ? "—" : ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`; }
function fmtTime(ts) { return ts ? new Date(ts).toLocaleTimeString("zh-CN", { hour12: false }) : ""; }

function prettyJson(s) {
  if (!s) return "";
  if (typeof s === "object") return JSON.stringify(s, null, 2);
  try { return JSON.stringify(JSON.parse(s), null, 2); } catch (_) { return String(s); }
}

function bodyAsString(b) {
  if (!b) return "";
  if (typeof b === "string") return b;
  return JSON.stringify(b);
}

function headersToArray(h) {
  if (!h) return [];
  if (Array.isArray(h)) return h;
  return Object.entries(h).map(([name, value]) => ({ name, value }));
}

function headersHtml(h) {
  const arr = headersToArray(h);
  if (!arr.length) return '<div class="no-data">（无 headers 数据）</div>';
  return `<table class="htable"><thead><tr><th>Name</th><th>Value</th></tr></thead><tbody>${arr
    .map((x) => `<tr><td class="hn">${esc(x.name)}</td><td>${esc(x.value || "")}</td></tr>`)
    .join("")}</tbody></table>`;
}

function isNoise(url) {
  return NOISE_PATTERNS.some((p) => p.test(url));
}

function filtered() {
  return requests.filter((r) => {
    if (hideNoise && isNoise(r.url)) return false;
    if (filterMethod !== "ALL" && r.method !== filterMethod) return false;
    if (filterText && !r.url.toLowerCase().includes(filterText)) return false;
    if (filterDomain) {
      const u = safeUrl(r.url);
      if (!u || u.hostname !== filterDomain) return false;
    }
    return true;
  });
}

function getDomains() {
  const map = {};
  requests.forEach((r) => {
    const u = safeUrl(r.url);
    if (u) map[u.hostname] = (map[u.hostname] || 0) + 1;
  });
  return Object.entries(map).sort((a, b) => b[1] - a[1]);
}

// ───────────────────────────────────────────────────────────────
// Domain Chips
// ───────────────────────────────────────────────────────────────

function renderDomainChips() {
  const domains = getDomains();
  const el = document.getElementById("domainChips");
  if (!domains.length) { el.innerHTML = ""; return; }
  el.innerHTML = `<span class="dchip${!filterDomain ? " active" : ""}" data-d="">ALL (${requests.length})</span>`
    + domains.map(([d, n]) =>
      `<span class="dchip${filterDomain === d ? " active" : ""}" data-d="${d}">${d} <b>${n}</b></span>`
    ).join("");
}

document.getElementById("domainChips").addEventListener("click", (e) => {
  const c = e.target.closest(".dchip");
  if (!c) return;
  filterDomain = c.dataset.d;
  renderDomainChips();
  refreshView();
});

// ───────────────────────────────────────────────────────────────
// Render
// ───────────────────────────────────────────────────────────────

function groupRequests(list) {
  if (groupMode === "none") return [{ label: null, items: list }];
  if (groupMode === "domain") {
    const map = new Map();
    list.forEach((r) => {
      const u = safeUrl(r.url);
      const key = u ? u.hostname : "unknown";
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(r);
    });
    return [...map.entries()].map(([label, items]) => ({ label: `🌐 ${label} (${items.length})`, items }));
  }
  if (groupMode === "time") {
    const sorted = [...list].sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
    const groups = [];
    let current = null;
    sorted.forEach((r) => {
      const ts = r.timestamp || 0;
      if (!current || ts - current.lastTs > 5000) {
        current = { label: `⏱ ${fmtTime(ts)}`, items: [], lastTs: ts };
        groups.push(current);
      }
      current.items.push(r);
      current.lastTs = ts;
    });
    groups.forEach((g) => { g.label += ` — ${g.items.length} 条请求`; });
    return groups;
  }
  return [{ label: null, items: list }];
}

function render() {
  const list = filtered();
  const noiseCount = requests.filter((r) => isNoise(r.url)).length;
  let statsText = `${list.length} / ${requests.length} requests`;
  if (hideNoise && noiseCount) statsText += ` (${noiseCount} noise hidden)`;
  document.getElementById("stats").textContent = statsText;
  updateBatchBar();

  const el = document.getElementById("content");
  if (!list.length) {
    el.innerHTML = `<div class="empty"><div class="empty-icon">${requests.length ? "🔍" : "🎬"}</div>
      <h3>${requests.length ? "无匹配" : "暂无录制"}</h3>
      <p>${requests.length ? "调整过滤条件" : "在 Cert Keeper 弹窗中点击 ● REC 开始录制"}</p></div>`;
    return;
  }

  const headerCount = (h) => headersToArray(h).length;
  const groups = groupRequests(list);
  let globalIdx = 0;

  el.innerHTML = groups.map((g) => {
    const groupHtml = g.label ? `<div class="group-header">${g.label}</div>` : "";
    const cardsHtml = g.items.map((r) => {
      const i = globalIdx++;
      const idx = requests.indexOf(r);
      return renderCard(r, i, idx, headerCount);
    }).join("");
    return groupHtml + cardsHtml;
  }).join("");
}

function renderCard(r, i, idx, headerCount) {
  const u = safeUrl(r.url);
  const path = u ? u.pathname + u.search : r.url;
  const body = prettyJson(r.requestBody);
  const isChecked = selected.has(idx) ? "checked" : "";

  return `<div class="card${selected.has(idx) ? " sel" : ""}" id="c${idx}" data-idx="${idx}">
    <div class="card-summary" data-action="toggle" data-idx="${idx}">
      <input type="checkbox" class="card-ck" data-action="check" data-idx="${idx}" ${isChecked}>
      <span class="seq">#${i + 1}</span>
      <span class="mtd mtd-${r.method}">${r.method}</span>
      <span class="url" title="${esc(r.url)}">${esc(path)}</span>
      <span class="sc ${scCls(r.statusCode)}">${r.statusCode || "ERR"}</span>
      <span class="dur">${fmtMs(r.duration)}</span>
    </div>
    <div class="card-detail">
      <div class="tabs">
        <div class="tab active" data-action="tab" data-idx="${idx}" data-tab="0">General</div>
        <div class="tab" data-action="tab" data-idx="${idx}" data-tab="1">Req Headers (${headerCount(r.requestHeaders)})</div>
        <div class="tab" data-action="tab" data-idx="${idx}" data-tab="2">Body</div>
        <div class="tab" data-action="tab" data-idx="${idx}" data-tab="3">Res Headers (${headerCount(r.responseHeaders)})</div>
        <div class="tab" data-action="tab" data-idx="${idx}" data-tab="4">Response</div>
      </div>
      <div class="pane active">
        <div class="fg"><div class="fl">Method</div><input class="fv" data-i="${idx}" data-f="method" value="${esc(r.method)}"></div>
        <div class="fg"><div class="fl">URL</div><input class="fv" data-i="${idx}" data-f="url" value="${esc(r.url)}"></div>
        <div class="fg"><div class="fl">Status</div><div class="fv">${r.statusCode || "Error"} ${r.statusLine || ""}</div></div>
        <div class="fg"><div class="fl">Timing</div><div class="fv">${fmtTime(r.timestamp)} · ${fmtMs(r.duration)}</div></div>
        ${r.error ? `<div class="fg"><div class="fl">Error</div><div class="fv fv-err">${esc(r.error)}</div></div>` : ""}
      </div>
      <div class="pane">${headersHtml(r.requestHeaders)}</div>
      <div class="pane">
        <div class="fg"><div class="fl">Request Body</div>
          <textarea class="fv fv-body" data-i="${idx}" data-f="requestBody" rows="8">${esc(body)}</textarea>
        </div>
      </div>
      <div class="pane">${headersHtml(r.responseHeaders)}</div>
      <div class="pane">
        ${r.responseBody
          ? `<div class="fg"><div class="fl">Response Body</div><pre class="fv fv-body resp-body jhl">${highlightJson(prettyJson(r.responseBody))}</pre></div>`
          : `<div class="resp-fetch-box"><p>Response Body 未录制</p><button class="abtn abtn-primary" data-action="fetchResp" data-idx="${idx}">🔄 重新发送并获取 Response</button></div>`
        }
      </div>
      <div class="card-actions">
        <button class="abtn" data-action="curl" data-idx="${idx}">📋 cURL</button>
        <button class="abtn" data-action="copyJson" data-idx="${idx}">📄 JSON</button>
        <button class="abtn" data-action="deleteOne" data-idx="${idx}">🗑 删除</button>
        <button class="abtn abtn-primary" data-action="apply" data-idx="${idx}">💾 应用编辑</button>
      </div>
    </div>
  </div>`;
}

// ───────────────────────────────────────────────────────────────
// Batch Select
// ───────────────────────────────────────────────────────────────

function updateBatchBar() {
  const bar = document.getElementById("batchBar");
  const cnt = document.getElementById("batchCount");
  if (selected.size > 0) {
    bar.classList.add("show");
    cnt.textContent = selected.size;
  } else {
    bar.classList.remove("show");
  }
}

document.getElementById("btnSelectAll").addEventListener("click", () => {
  const list = filtered();
  const allSelected = list.every((r) => selected.has(requests.indexOf(r)));
  if (allSelected) {
    list.forEach((r) => selected.delete(requests.indexOf(r)));
  } else {
    list.forEach((r) => selected.add(requests.indexOf(r)));
  }
  render();
});

document.getElementById("btnBatchDel").addEventListener("click", () => {
  if (!selected.size) return;
  if (!confirm(`删除选中的 ${selected.size} 条请求？`)) return;
  const toRemove = [...selected].sort((a, b) => b - a);
  toRemove.forEach((idx) => requests.splice(idx, 1));
  selected.clear();
  renderDomainChips();
  render();
  toast(`🗑 已删除 ${toRemove.length} 条`);
});

document.getElementById("btnBatchCurl").addEventListener("click", () => {
  if (!selected.size) return;
  const curls = [...selected].sort((a, b) => a - b).map((idx) => buildCurl(idx));
  navigator.clipboard.writeText(curls.join("\n\n"));
  toast(`📋 已复制 ${curls.length} 条 cURL`);
});

// ───────────────────────────────────────────────────────────────
// Drag Select — hold mouse and swipe across cards to select
// ───────────────────────────────────────────────────────────────

let dragState = null;

document.getElementById("content").addEventListener("mousedown", (e) => {
  if (e.button !== 0) return;
  const summary = e.target.closest(".card-summary");
  if (!summary || e.target.type === "checkbox" || e.target.closest("[data-action='tab']")) return;
  const card = summary.closest(".card");
  if (!card) return;
  const idx = parseInt(card.dataset.idx);
  dragState = { startIdx: idx, lastIdx: idx, moved: false };
});

document.getElementById("content").addEventListener("mousemove", (e) => {
  if (!dragState) return;
  const summary = e.target.closest(".card-summary");
  if (!summary) return;
  const card = summary.closest(".card");
  if (!card) return;
  const idx = parseInt(card.dataset.idx);
  if (idx === dragState.lastIdx) return;
  dragState.moved = true;
  dragState.lastIdx = idx;

  const minIdx = Math.min(dragState.startIdx, idx);
  const maxIdx = Math.max(dragState.startIdx, idx);

  selected.clear();
  document.querySelectorAll(".card").forEach((c) => {
    const ci = parseInt(c.dataset.idx);
    if (ci >= minIdx && ci <= maxIdx) {
      selected.add(ci);
      c.classList.add("sel");
      const ck = c.querySelector(".card-ck");
      if (ck) ck.checked = true;
    } else {
      c.classList.remove("sel");
      const ck = c.querySelector(".card-ck");
      if (ck) ck.checked = false;
    }
  });
  updateBatchBar();
});

document.addEventListener("mouseup", () => {
  if (dragState?.moved) {
    // prevent the click from toggling the card open/close
    const handler = (e) => { e.stopPropagation(); };
    document.getElementById("content").addEventListener("click", handler, { capture: true, once: true });
  }
  dragState = null;
});

// ───────────────────────────────────────────────────────────────
// Event Delegation
// ───────────────────────────────────────────────────────────────

document.getElementById("content").addEventListener("click", (e) => {
  const target = e.target.closest("[data-action]");
  if (!target) return;
  const action = target.dataset.action;
  const idx = parseInt(target.dataset.idx);

  switch (action) {
    case "check": {
      e.stopPropagation();
      if (selected.has(idx)) selected.delete(idx); else selected.add(idx);
      const card = document.getElementById(`c${idx}`);
      card?.classList.toggle("sel", selected.has(idx));
      updateBatchBar();
      break;
    }
    case "toggle": {
      if (e.target.type === "checkbox") return;
      document.getElementById(`c${idx}`)?.classList.toggle("open");
      break;
    }
    case "tab": {
      const n = parseInt(target.dataset.tab);
      const card = document.getElementById(`c${idx}`);
      if (!card) break;
      card.querySelectorAll(".tab").forEach((t, j) => t.classList.toggle("active", j === n));
      card.querySelectorAll(".pane").forEach((p, j) => p.classList.toggle("active", j === n));
      break;
    }
    case "curl": { copyCurl(idx); break; }
    case "copyJson": {
      const r = requests[idx];
      const hArr = headersToArray(r.requestHeaders);
      const obj = {
        method: r.method, url: r.url, statusCode: r.statusCode,
        headers: hArr.reduce((o, h) => { o[h.name] = h.value; return o; }, {}),
        body: typeof r.requestBody === "string" ? tryParse(r.requestBody) : r.requestBody,
      };
      navigator.clipboard.writeText(JSON.stringify(obj, null, 2));
      toast("📄 JSON copied");
      break;
    }
    case "apply": {
      const card = document.getElementById(`c${idx}`);
      if (!card) break;
      card.querySelectorAll("[data-f]").forEach((el) => { requests[idx][el.dataset.f] = el.value; });
      toast("✅ 已应用编辑");
      break;
    }
    case "deleteOne": {
      requests.splice(idx, 1);
      const newSel = new Set();
      selected.forEach((si) => {
        if (si < idx) newSel.add(si);
        else if (si > idx) newSel.add(si - 1);
      });
      selected = newSel;
      renderDomainChips();
      render();
      toast("🗑 已删除");
      break;
    }
    case "fetchResp": {
      fetchResponse(idx, target);
      break;
    }
  }
});

function buildCurl(idx) {
  const r = requests[idx];
  const hArr = headersToArray(r.requestHeaders);
  let c = `curl '${r.url}'`;
  if (r.method !== "GET") c += ` \\\n  -X ${r.method}`;
  hArr.forEach((h) => {
    const name = h.name.toLowerCase();
    if (!["host", "content-length", "accept-encoding"].includes(name)) {
      c += ` \\\n  -H '${h.name}: ${(h.value || "").replace(/'/g, "'\\''")}'`;
    }
  });
  const bodyStr = bodyAsString(r.requestBody);
  if (bodyStr) c += ` \\\n  --data-raw '${bodyStr.replace(/'/g, "'\\''")}'`;
  return c;
}

function copyCurl(idx) {
  navigator.clipboard.writeText(buildCurl(idx));
  toast("📋 cURL copied");
}

async function fetchResponse(idx, btn) {
  const r = requests[idx];
  btn.textContent = "⏳ 发送中…";
  btn.disabled = true;
  try {
    const resp = await chrome.runtime.sendMessage({
      action: "fetchResponse",
      url: r.url,
      method: r.method,
      headers: headersToArray(r.requestHeaders).reduce((o, h) => {
        const n = h.name.toLowerCase();
        if (!["host", "content-length", "accept-encoding", "sec-ch-ua", "sec-fetch-site", "sec-fetch-mode", "sec-fetch-dest"].includes(n))
          o[h.name] = h.value;
        return o;
      }, {}),
      body: bodyAsString(r.requestBody) || undefined,
    });
    if (resp?.ok) {
      requests[idx].responseBody = resp.body;
      requests[idx].statusCode = resp.status;
      const card = document.getElementById(`c${idx}`);
      if (card) {
        const panes = card.querySelectorAll(".pane");
        const respPane = panes[4];
        if (respPane) {
          respPane.innerHTML = `<div class="fg"><div class="fl">Response Body (${resp.status})</div><pre class="fv fv-body resp-body jhl">${highlightJson(prettyJson(resp.body))}</pre></div>`;
        }
      }
      toast(`✅ 获取到 Response (${resp.status})`);
    } else {
      btn.textContent = `❌ ${resp?.error || "失败"}`;
    }
  } catch (e) {
    btn.textContent = `❌ ${e.message}`;
  }
}

// ───────────────────────────────────────────────────────────────
// Filter
// ───────────────────────────────────────────────────────────────

function refreshView() {
  render();
  if (currentView === "timeline") renderTimeline();
}

let _filterTimer;
document.getElementById("filterInput").addEventListener("input", (e) => {
  clearTimeout(_filterTimer);
  _filterTimer = setTimeout(() => {
    filterText = e.target.value.trim().toLowerCase();
    refreshView();
  }, 150);
});

document.getElementById("ckNoise").addEventListener("change", (e) => {
  hideNoise = e.target.checked;
  renderDomainChips();
  refreshView();
});

document.getElementById("groupChips").addEventListener("click", (e) => {
  const c = e.target.closest(".gchip");
  if (!c) return;
  document.querySelectorAll("#groupChips .gchip").forEach((x) => x.classList.remove("active"));
  c.classList.add("active");
  groupMode = c.dataset.g;
  refreshView();
});

document.getElementById("methodChips").addEventListener("click", (e) => {
  const c = e.target.closest(".chip");
  if (!c) return;
  document.querySelectorAll("#methodChips .chip").forEach((x) => x.classList.remove("active"));
  c.classList.add("active");
  filterMethod = c.dataset.m;
  refreshView();
});

// ───────────────────────────────────────────────────────────────
// Export / Save / Clear
// ───────────────────────────────────────────────────────────────

function exportData() {
  return filtered().map((r) => ({
    method: r.method, url: r.url, statusCode: r.statusCode,
    duration: r.duration, timestamp: r.timestamp,
    requestHeaders: headersToArray(r.requestHeaders).map((h) => ({ name: h.name, value: h.value })),
    requestBody: typeof r.requestBody === "string" ? tryParse(r.requestBody) : r.requestBody,
    responseHeaders: headersToArray(r.responseHeaders).map((h) => ({ name: h.name, value: h.value })),
    responseBody: r.responseBody || null,
  }));
}

function tryParse(s) { try { return JSON.parse(s); } catch (_) { return s || null; } }

document.getElementById("btnExport").addEventListener("click", () => {
  const d = exportData();
  const filename = `api-recording-${ts()}.json`;
  download(filename, JSON.stringify(d, null, 2), "application/json");
  navigator.clipboard.writeText(filename);
  toast(`📥 已导出 ${d.length} 条 · 文件名已复制`);
});

document.getElementById("btnSave").addEventListener("click", async () => {
  const d = exportData();
  try {
    const r = await fetch(`${SERVER_URL}/save-recording`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requests: d }),
    });
    if (r.ok) {
      const j = await r.json();
      navigator.clipboard.writeText(j.path);
      toast(`💾 已保存 · 路径已复制: ${j.path}`);
    } else {
      toast(`❌ 保存失败: ${r.status}`);
    }
  } catch (_) {
    toast("❌ 本地服务未运行");
  }
});

document.getElementById("btnClear").addEventListener("click", async () => {
  if (!confirm("清空所有录制数据？")) return;
  requests = [];
  selected.clear();
  try { await chrome.runtime.sendMessage({ action: "clearRecording" }); } catch (_) {}
  renderDomainChips();
  render();
  if (currentView === "timeline") renderTimeline();
  toast("🗑 已清空");
});

// ───────────────────────────────────────────────────────────────
// Skill Generation
// ───────────────────────────────────────────────────────────────

document.getElementById("btnSkill").addEventListener("click", () => {
  const list = filtered();
  if (!list.length) return toast("无数据可生成");
  document.getElementById("skillStepCount").textContent = `(${list.length} steps)`;
  document.getElementById("skillPreview").textContent = generateSkillMd(list);
  if (!document.getElementById("skillName").value) {
    const u = safeUrl(list[0]?.url);
    if (u) document.getElementById("skillName").value = u.hostname.split(".")[0] + "-workflow";
  }
  document.getElementById("skillModal").classList.add("show");
});

document.getElementById("skillModalClose").addEventListener("click", () => {
  document.getElementById("skillModal").classList.remove("show");
});

document.getElementById("btnSkillCopy").addEventListener("click", () => {
  navigator.clipboard.writeText(document.getElementById("skillPreview").textContent);
  toast("📋 Markdown 已复制");
});

document.getElementById("btnSkillDownload").addEventListener("click", () => {
  const name = document.getElementById("skillName").value || "api-workflow";
  download(`${name}.md`, document.getElementById("skillPreview").textContent, "text/markdown");
  toast("📥 已下载 .md");
});

document.getElementById("btnSkillGenerate").addEventListener("click", async () => {
  const name = document.getElementById("skillName").value?.trim();
  const desc = document.getElementById("skillDesc").value?.trim();
  const requirements = document.getElementById("skillRequirements")?.value?.trim();
  const statusEl = document.getElementById("skillGenStatus");
  if (!name) { toast("⚠ 请填写 Skill 名称"); return; }
  statusEl.textContent = "⏳ 正在生成 Skill…";
  statusEl.className = "modal-status loading";
  try {
    const data = exportData();
    const resp = await fetch(`${SERVER_URL}/gen-skill`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, desc, requirements, requests: data }),
    });
    const result = await resp.json();
    if (result.ok) {
      const prompt = `读取 ${result.skill_dir}/.agent_prompt.md 和 api_spec.json，根据用户诉求完善 main.py 的实现`;
      await navigator.clipboard.writeText(prompt);
      statusEl.innerHTML = `✅ Skill 已生成 · <b>Prompt 已复制到剪贴板</b><br>`
        + `<code>${result.skill_dir}</code><br>`
        + `<small>👉 直接粘贴到 Cursor 对话框即可</small>`;
      statusEl.className = "modal-status ok";
      toast("✅ 已复制 Cursor Prompt → 粘贴到 Cursor 对话框");
    } else {
      statusEl.textContent = `❌ ${result.error || "生成失败"}`;
      statusEl.className = "modal-status err";
    }
  } catch (e) {
    statusEl.textContent = `❌ 服务未运行: ${e.message}`;
    statusEl.className = "modal-status err";
  }
});

function generateSkillMd(list) {
  const name = document.getElementById("skillName").value || "api-workflow";
  const desc = document.getElementById("skillDesc").value || "从 API 录制自动生成的 Skill";
  const host = safeUrl(list[0]?.url)?.origin || "https://example.com";

  let md = `# Skill: ${name}\n\n${desc}\n\n`;
  md += `## API Chain (${list.length} steps)\n\n`;
  md += `**Base URL**: \`${host}\`\n\n`;

  list.forEach((r, i) => {
    const u = safeUrl(r.url);
    const path = u ? u.pathname : r.url;
    md += `### Step ${i + 1}: ${r.method} ${path}\n\n`;
    md += `| Field | Value |\n|-------|-------|\n`;
    md += `| Method | \`${r.method}\` |\n`;
    md += `| URL | \`${r.url}\` |\n`;
    md += `| Status | ${r.statusCode || "N/A"} |\n`;
    md += `| Duration | ${fmtMs(r.duration)} |\n\n`;

    const hArr = headersToArray(r.requestHeaders);
    if (hArr.length) {
      const important = hArr.filter((h) =>
        ["content-type", "authorization", "cookie", "accept", "x-"].some(
          (p) => h.name.toLowerCase().startsWith(p) || h.name.toLowerCase() === p
        )
      );
      if (important.length) {
        md += "**Key Headers**:\n```\n";
        important.forEach((h) => (md += `${h.name}: ${h.value}\n`));
        md += "```\n\n";
      }
    }

    if (r.requestBody) {
      md += "**Request Body**:\n```json\n";
      md += prettyJson(r.requestBody);
      md += "\n```\n\n";
    }
    md += "---\n\n";
  });

  md += `## cURL Commands\n\n`;
  list.forEach((r, i) => {
    md += `\`\`\`bash\n# Step ${i + 1}: ${r.method} ${safeUrl(r.url)?.pathname || r.url}\n`;
    md += `curl '${r.url}'`;
    if (r.method !== "GET") md += ` -X ${r.method}`;
    const bs = bodyAsString(r.requestBody);
    if (bs) {
      const truncated = bs.length > 200 ? bs.substring(0, 200) + "..." : bs;
      md += ` \\\n  -d '${truncated.replace(/'/g, "'\\''")}'`;
    }
    md += `\n\`\`\`\n\n`;
  });

  return md;
}

// ───────────────────────────────────────────────────────────────
// View Toggle (List / Timeline)
// ───────────────────────────────────────────────────────────────

let currentView = "list";

document.getElementById("viewToggle").addEventListener("click", (e) => {
  const btn = e.target.closest(".vt-btn");
  if (!btn) return;
  currentView = btn.dataset.v;
  document.querySelectorAll("#viewToggle .vt-btn").forEach((b) => b.classList.toggle("active", b === btn));
  document.getElementById("content").style.display = currentView === "list" ? "" : "none";
  document.getElementById("timelineContainer").style.display = currentView === "timeline" ? "" : "none";
  if (currentView === "timeline") renderTimeline();
});

// ───────────────────────────────────────────────────────────────
// Timeline / Waterfall View
// ───────────────────────────────────────────────────────────────

function renderTimeline() {
  const list = filtered();
  const el = document.getElementById("timelineContainer");

  if (!list.length) {
    el.innerHTML = '<div class="empty"><p>无请求数据</p></div>';
    return;
  }

  const withTs = list.filter((r) => r.timestamp);
  if (!withTs.length) {
    el.innerHTML = '<div class="empty"><p>无时间戳数据</p></div>';
    return;
  }

  const tMin = Math.min(...withTs.map((r) => r.timestamp));
  const tMax = Math.max(...withTs.map((r) => r.timestamp + (r.duration || 0)));
  const span = tMax - tMin || 1;

  const barWidth = 100;
  const scaleLabels = 5;
  const scales = [];
  for (let i = 0; i <= scaleLabels; i++) {
    const t = tMin + (span / scaleLabels) * i;
    const pct = ((t - tMin) / span) * barWidth;
    const ms = t - tMin;
    scales.push(`<div class="tl-scale" style="left:${pct}%">${ms < 1000 ? Math.round(ms) + "ms" : (ms / 1000).toFixed(1) + "s"}</div>`);
  }

  const rows = withTs.map((r, i) => {
    const u = safeUrl(r.url);
    const path = u ? u.pathname : r.url;
    const startPct = ((r.timestamp - tMin) / span) * barWidth;
    const durPct = Math.max(((r.duration || 50) / span) * barWidth, 0.3);
    const sc = r.statusCode || 0;
    const barClass = sc >= 200 && sc < 300 ? "tl-ok" : sc >= 400 ? "tl-err" : sc >= 300 ? "tl-redir" : "tl-pending";

    return `<div class="tl-row" title="${esc(r.url)}">
      <div class="tl-label">
        <span class="mtd mtd-${r.method}" style="font-size:8px;padding:1px 4px">${r.method}</span>
        <span class="tl-path">${esc(path.length > 40 ? "…" + path.slice(-38) : path)}</span>
      </div>
      <div class="tl-track">
        <div class="tl-bar ${barClass}" style="left:${startPct}%;width:${durPct}%">
          <span class="tl-dur">${fmtMs(r.duration)}</span>
        </div>
      </div>
      <div class="tl-status ${scCls(sc)}">${sc || "ERR"}</div>
    </div>`;
  }).join("");

  el.innerHTML = `<div class="tl-header">
    <div class="tl-label tl-label-hd">请求</div>
    <div class="tl-track tl-scale-track">${scales.join("")}</div>
    <div class="tl-status tl-label-hd">状态</div>
  </div>${rows}
  <div class="tl-summary">
    ${withTs.length} 请求 · 总耗时 ${fmtMs(span)} · 
    并行峰值 ${calcMaxParallel(withTs)}
  </div>`;
}

function calcMaxParallel(list) {
  const events = [];
  list.forEach((r) => {
    if (!r.timestamp) return;
    events.push({ t: r.timestamp, d: 1 });
    events.push({ t: r.timestamp + (r.duration || 0), d: -1 });
  });
  events.sort((a, b) => a.t - b.t || a.d - b.d);
  let max = 0, cur = 0;
  events.forEach((e) => { cur += e.d; if (cur > max) max = cur; });
  return max;
}

// ───────────────────────────────────────────────────────────────
// JSON Syntax Highlighting
// ───────────────────────────────────────────────────────────────

function highlightJson(str) {
  if (!str) return "";
  const e = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return e(str).replace(
    /("(?:\\.|[^"\\])*")\s*:/g,
    '<span class="jk">$1</span>:'
  ).replace(
    /:\s*("(?:\\.|[^"\\])*")/g,
    ': <span class="js">$1</span>'
  ).replace(
    /:\s*(\d+\.?\d*)\b/g,
    ': <span class="jn">$1</span>'
  ).replace(
    /:\s*(true|false)\b/g,
    ': <span class="jb">$1</span>'
  ).replace(
    /:\s*(null)\b/g,
    ': <span class="jnull">$1</span>'
  );
}

// ───────────────────────────────────────────────────────────────
// Dark Mode
// ───────────────────────────────────────────────────────────────

function initTheme() {
  const saved = localStorage.getItem("theme");
  if (saved === "dark" || (!saved && window.matchMedia("(prefers-color-scheme: dark)").matches)) {
    document.body.classList.add("dark");
    const btn = document.getElementById("btnTheme");
    if (btn) btn.textContent = "☀️";
  }
}

document.getElementById("btnTheme").addEventListener("click", () => {
  const isDark = document.body.classList.toggle("dark");
  localStorage.setItem("theme", isDark ? "dark" : "light");
  document.getElementById("btnTheme").textContent = isDark ? "☀️" : "🌙";
});

// ───────────────────────────────────────────────────────────────
// Keyboard Shortcuts
// ───────────────────────────────────────────────────────────────

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    const modal = document.getElementById("skillModal");
    if (modal.classList.contains("show")) {
      modal.classList.remove("show");
      return;
    }
    if (selected.size) { selected.clear(); render(); return; }
  }

  if ((e.ctrlKey || e.metaKey) && e.key === "a") {
    if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;
    e.preventDefault();
    const list = filtered();
    list.forEach((r) => selected.add(requests.indexOf(r)));
    render();
  }

  if ((e.key === "Delete" || e.key === "Backspace") && selected.size) {
    if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;
    e.preventDefault();
    if (!confirm(`删除选中的 ${selected.size} 条请求？`)) return;
    const toRemove = [...selected].sort((a, b) => b - a);
    toRemove.forEach((idx) => requests.splice(idx, 1));
    selected.clear();
    renderDomainChips();
    render();
    toast(`🗑 已删除 ${toRemove.length} 条`);
  }
});

// ───────────────────────────────────────────────────────────────
// Utils
// ───────────────────────────────────────────────────────────────

function toast(msg) {
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = msg;
  document.getElementById("toastContainer").appendChild(el);
  setTimeout(() => el.remove(), 3000);
}

function download(name, content, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function ts() { return new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-"); }

// ───────────────────────────────────────────────────────────────
// Init
// ───────────────────────────────────────────────────────────────

initTheme();
load();
