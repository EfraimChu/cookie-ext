const SERVER_URL = "http://localhost:19222";
let requests = [];
let filterMethod = "ALL";
let filterText = "";

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
  render();
}

// ───────────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────────

const esc = (s) => s ? s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;") : "";
const safeUrl = (s) => { try { return new URL(s); } catch (_) { return null; } };

function scCls(c) {
  if (!c) return "sc-0";
  return `sc-${Math.floor(c / 100)}`;
}

function fmtMs(ms) {
  if (ms == null) return "—";
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function fmtTime(ts) {
  return ts ? new Date(ts).toLocaleTimeString("zh-CN", { hour12: false }) : "";
}

function prettyJson(s) {
  if (!s) return s;
  try { return JSON.stringify(JSON.parse(s), null, 2); } catch (_) { return s; }
}

function headersTable(h) {
  if (!h?.length) return '<span style="color:var(--text2)">（无）</span>';
  return `<table class="htable"><thead><tr><th>Name</th><th>Value</th></tr></thead><tbody>${
    h.map((x) => `<tr><td class="hn">${esc(x.name)}</td><td>${esc(x.value || "")}</td></tr>`).join("")
  }</tbody></table>`;
}

function filtered() {
  return requests.filter((r) => {
    if (filterMethod !== "ALL" && r.method !== filterMethod) return false;
    if (filterText && !r.url.toLowerCase().includes(filterText)) return false;
    return true;
  });
}

// ───────────────────────────────────────────────────────────────
// Render
// ───────────────────────────────────────────────────────────────

function render() {
  const list = filtered();
  document.getElementById("stats").textContent = `${list.length} / ${requests.length} requests`;
  const el = document.getElementById("content");

  if (!list.length) {
    el.innerHTML = `<div class="empty"><div class="empty-icon">${requests.length ? "🔍" : "🎬"}</div>
      <h3>${requests.length ? "无匹配" : "暂无录制"}</h3>
      <p>${requests.length ? "调整过滤条件" : "在弹窗中点击 ● REC 开始录制"}</p></div>`;
    return;
  }

  el.innerHTML = list.map((r, i) => {
    const idx = requests.indexOf(r);
    const u = safeUrl(r.url);
    const path = u ? u.pathname + u.search : r.url;
    const body = prettyJson(r.requestBody);

    return `<div class="card" id="c${idx}">
      <div class="card-summary" onclick="toggle(${idx})">
        <span class="seq">${i + 1}</span>
        <span class="mtd mtd-${r.method}">${r.method}</span>
        <span class="url" title="${esc(r.url)}">${esc(path)}</span>
        <span class="sc ${scCls(r.statusCode)}">${r.statusCode || "ERR"}</span>
        <span class="dur">${fmtMs(r.duration)}</span>
      </div>
      <div class="card-detail">
        <div class="tabs">
          <div class="tab active" onclick="tab(${idx},0)">General</div>
          <div class="tab" onclick="tab(${idx},1)">Req Headers</div>
          <div class="tab" onclick="tab(${idx},2)">Body</div>
          <div class="tab" onclick="tab(${idx},3)">Res Headers</div>
        </div>
        <div class="pane active">
          <div class="fg"><div class="fl">Method</div><input class="fv" data-i="${idx}" data-f="method" value="${esc(r.method)}"></div>
          <div class="fg"><div class="fl">URL</div><input class="fv" data-i="${idx}" data-f="url" value="${esc(r.url)}"></div>
          <div class="fg"><div class="fl">Status</div><div class="fv">${r.statusCode || "Error"} ${r.statusLine || ""}</div></div>
          <div class="fg"><div class="fl">Time</div><div class="fv">${fmtTime(r.timestamp)} · ${fmtMs(r.duration)}</div></div>
        </div>
        <div class="pane">${headersTable(r.requestHeaders)}</div>
        <div class="pane">
          <div class="fg"><div class="fl">Request Body</div>
            <textarea class="fv" data-i="${idx}" data-f="requestBody" rows="6">${esc(body || "")}</textarea>
          </div>
        </div>
        <div class="pane">${headersTable(r.responseHeaders)}</div>
        <div class="card-actions">
          <button class="abtn" onclick="curl(${idx})">📋 cURL</button>
          <button class="abtn abtn-primary" onclick="save(${idx})">💾 应用编辑</button>
        </div>
      </div>
    </div>`;
  }).join("");
}

// ───────────────────────────────────────────────────────────────
// Card Interactions
// ───────────────────────────────────────────────────────────────

window.toggle = (i) => document.getElementById(`c${i}`)?.classList.toggle("open");

window.tab = (i, n) => {
  const card = document.getElementById(`c${i}`);
  if (!card) return;
  card.querySelectorAll(".tab").forEach((t, j) => t.classList.toggle("active", j === n));
  card.querySelectorAll(".pane").forEach((p, j) => p.classList.toggle("active", j === n));
};

window.save = (i) => {
  const card = document.getElementById(`c${i}`);
  if (!card) return;
  card.querySelectorAll("[data-f]").forEach((el) => {
    requests[i][el.dataset.f] = el.value;
  });
  toast("✅ 已应用");
};

window.curl = (i) => {
  const r = requests[i];
  let c = `curl '${r.url}'`;
  if (r.method !== "GET") c += ` \\\n  -X ${r.method}`;
  (r.requestHeaders || []).forEach((h) => {
    if (!["host", "content-length", "accept-encoding"].includes(h.name.toLowerCase())) {
      c += ` \\\n  -H '${h.name}: ${(h.value || "").replace(/'/g, "'\\''")}'`;
    }
  });
  if (r.requestBody) c += ` \\\n  --data-raw '${r.requestBody.replace(/'/g, "'\\''")}'`;
  navigator.clipboard.writeText(c);
  toast("📋 cURL copied");
};

// ───────────────────────────────────────────────────────────────
// Filter
// ───────────────────────────────────────────────────────────────

document.getElementById("filterInput").addEventListener("input", (e) => {
  filterText = e.target.value.trim().toLowerCase();
  render();
});

document.getElementById("methodChips").addEventListener("click", (e) => {
  const c = e.target.closest(".chip");
  if (!c) return;
  document.querySelectorAll(".chip").forEach((x) => x.classList.remove("active"));
  c.classList.add("active");
  filterMethod = c.dataset.m;
  render();
});

// ───────────────────────────────────────────────────────────────
// Export / Save / Clear
// ───────────────────────────────────────────────────────────────

function exportData() {
  return filtered().map((r) => ({
    method: r.method, url: r.url, statusCode: r.statusCode,
    duration: r.duration, timestamp: r.timestamp,
    requestHeaders: r.requestHeaders?.reduce((o, h) => { o[h.name] = h.value; return o; }, {}),
    requestBody: tryParse(r.requestBody),
    responseHeaders: r.responseHeaders?.reduce((o, h) => { o[h.name] = h.value; return o; }, {}),
  }));
}

function tryParse(s) { try { return JSON.parse(s); } catch (_) { return s || null; } }

document.getElementById("btnExport").addEventListener("click", () => {
  const d = exportData();
  download(`api-recording-${ts()}.json`, JSON.stringify(d, null, 2), "application/json");
  toast(`📥 已导出 ${d.length} 条`);
});

document.getElementById("btnSave").addEventListener("click", async () => {
  const d = exportData();
  try {
    const r = await fetch(`${SERVER_URL}/save-recording`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requests: d }),
    });
    if (r.ok) { const j = await r.json(); toast(`💾 ${j.path}`); }
    else toast(`❌ ${r.status}`);
  } catch (_) { toast("❌ 服务未运行"); }
});

document.getElementById("btnClear").addEventListener("click", () => {
  if (!confirm("清空所有录制数据？")) return;
  requests = [];
  chrome.storage.local.remove("lastRecording");
  render();
  toast("🗑 已清空");
});

// ───────────────────────────────────────────────────────────────
// Skill Generation — converts API chain to Cursor Skill template
// ───────────────────────────────────────────────────────────────

document.getElementById("btnSkill").addEventListener("click", () => {
  const list = filtered();
  if (!list.length) return toast("无数据可生成");
  document.getElementById("skillStepCount").textContent = `(${list.length} steps)`;
  document.getElementById("skillPreview").textContent = generateSkillMd(list);
  document.getElementById("skillModal").classList.add("show");
});

document.getElementById("skillModalClose").addEventListener("click", () => {
  document.getElementById("skillModal").classList.remove("show");
});

document.getElementById("btnSkillCopy").addEventListener("click", () => {
  navigator.clipboard.writeText(document.getElementById("skillPreview").textContent);
  toast("📋 已复制 Markdown");
});

document.getElementById("btnSkillDownload").addEventListener("click", () => {
  const name = document.getElementById("skillName").value || "api-workflow";
  download(`${name}.md`, document.getElementById("skillPreview").textContent, "text/markdown");
  toast("📥 已下载");
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
    md += `- **Method**: \`${r.method}\`\n`;
    md += `- **URL**: \`${r.url}\`\n`;
    md += `- **Status**: ${r.statusCode || "N/A"}\n`;
    md += `- **Duration**: ${fmtMs(r.duration)}\n\n`;

    if (r.requestHeaders?.length) {
      const important = r.requestHeaders.filter((h) =>
        ["content-type", "authorization", "cookie", "x-"].some((p) =>
          h.name.toLowerCase().startsWith(p) || h.name.toLowerCase() === p
        )
      );
      if (important.length) {
        md += "**Key Headers**:\n```\n";
        important.forEach((h) => { md += `${h.name}: ${h.value}\n`; });
        md += "```\n\n";
      }
    }

    if (r.requestBody) {
      md += "**Request Body**:\n```json\n";
      md += prettyJson(r.requestBody) || r.requestBody;
      md += "\n```\n\n";
    }

    md += "---\n\n";
  });

  md += `## Usage\n\n`;
  md += "```bash\n";
  list.forEach((r, i) => {
    md += `# Step ${i + 1}: ${r.method} ${safeUrl(r.url)?.pathname || r.url}\n`;
    md += `curl '${r.url}'`;
    if (r.method !== "GET") md += ` -X ${r.method}`;
    if (r.requestBody) md += ` \\\n  -d '${r.requestBody.replace(/'/g, "'\\''").substring(0, 200)}${r.requestBody.length > 200 ? "..." : ""}'`;
    md += "\n\n";
  });
  md += "```\n";

  return md;
}

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
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

function ts() {
  return new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-");
}

// ───────────────────────────────────────────────────────────────
// Init
// ───────────────────────────────────────────────────────────────

load();
