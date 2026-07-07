/* renderer.js — UI logic. Talks to main via window.workbench (preload). */

const chat = document.getElementById("chat");
const emptyState = document.getElementById("emptyState");
const input = document.getElementById("input");
const sendBtn = document.getElementById("sendBtn");
const folderBtn = document.getElementById("folderBtn");
const emptyFolderBtn = document.getElementById("emptyFolderBtn");
const folderLabel = document.getElementById("folderLabel");
const modelSelect = document.getElementById("modelSelect");
const newChatBtn = document.getElementById("newChatBtn");
const autoApprove = document.getElementById("autoApprove");
const statusBar = document.getElementById("statusBar");
const statusText = document.getElementById("statusText");
const planksEl = document.getElementById("planks");
const ctxLabel = document.getElementById("ctxLabel");
const stopBtn = document.getElementById("stopBtn");
const starters = document.getElementById("starters");
const ctxSelect = document.getElementById("ctxSelect");

const PLANK_COUNT = 14;
let busy = false;
let folderChosen = false;
let currentCtx = parseInt(ctxSelect.value, 10);

/* ---------- build the floorboard meter ---------- */
for (let i = 0; i < PLANK_COUNT; i++) {
  const p = document.createElement("div");
  p.className = "plank";
  planksEl.appendChild(p);
}

function setMeter(used, max) {
  const frac = Math.min(used / max, 1);
  const laid = Math.round(frac * PLANK_COUNT);
  const level = frac > 0.85 ? "danger" : frac > 0.6 ? "warn" : "";
  planksEl.querySelectorAll(".plank").forEach((p, i) => {
    p.className = "plank" + (i < laid ? " laid " + level : "");
  });
  ctxLabel.textContent = `${(used / 1000).toFixed(1)}k / ${Math.round(max / 1000)}k`;
}

/* ---------- chat helpers ---------- */

function addMsg(cls, text) {
  const div = document.createElement("div");
  div.className = "msg " + cls;
  div.textContent = text;
  chat.appendChild(div);
  chat.scrollTop = chat.scrollHeight;
  return div;
}

function addToolChip(name, args) {
  const labels = {
    list_dir: a => `Looking in ${a.path || "the folder"}`,
    read_file: a => `Reading ${a.path}`,
    write_file: a => `Preparing to write ${a.path}`,
    edit_file: a => `Preparing an edit to ${a.path}`,
    search_files: a => `Searching for “${a.pattern}”`,
    run_command: () => `Preparing a command`,
  };
  const div = document.createElement("div");
  div.className = "tool-chip";
  div.textContent = (labels[name] || (() => name))(args || {});
  chat.appendChild(div);
  chat.scrollTop = chat.scrollHeight;
}

function addApprovalCard({ id, kind, title, detail }) {
  const card = document.createElement("div");
  card.className = "approval";

  const kindWord = { write: "File change", edit: "File change", command: "Command" }[kind] || "Action";
  const head = document.createElement("div");
  head.className = "approval-title";
  const kindEl = document.createElement("span");
  kindEl.className = "kind";
  kindEl.textContent = kindWord;
  head.appendChild(kindEl);
  head.appendChild(document.createTextNode(title));

  const pre = document.createElement("pre");
  // color diff lines without using innerHTML on raw content
  for (const line of String(detail).split("\n")) {
    const span = document.createElement("span");
    if (line.startsWith("+")) span.className = "add";
    else if (line.startsWith("-")) span.className = "del";
    span.textContent = line + "\n";
    pre.appendChild(span);
  }

  const actions = document.createElement("div");
  actions.className = "approval-actions";
  const allow = document.createElement("button");
  allow.className = "btn btn-primary";
  allow.textContent = "Allow";
  const deny = document.createElement("button");
  deny.className = "btn btn-deny";
  deny.textContent = "Don't allow";

  const decide = approved => {
    window.workbench.respondApproval(id, approved);
    card.classList.add("decided");
    actions.remove();
    const note = document.createElement("div");
    note.className = "decision";
    note.textContent = approved ? "Allowed" : "Not allowed";
    card.appendChild(note);
  };
  allow.addEventListener("click", () => decide(true));
  deny.addEventListener("click", () => decide(false));

  actions.append(allow, deny);
  card.append(head, pre, actions);
  chat.appendChild(card);
  chat.scrollTop = chat.scrollHeight;
}

/* ---------- status ---------- */

function setBusy(on, label) {
  busy = on;
  sendBtn.disabled = on;
  stopBtn.hidden = !on;
  statusBar.hidden = false;
  statusText.className = "status-text" + (on ? " working-dots" : "");
  statusText.textContent = label || (on ? "Working" : "Ready");
}

/* ---------- events from the agent ---------- */

window.workbench.on("agent:thinking", ({ step, max }) =>
  setBusy(true, `Working — step ${step} of ${max}`));

window.workbench.on("agent:stats", s => {
  setMeter(s.ctxUsed, s.ctxMax);
  const tps = s.tps ? `  ·  ${Math.round(s.tps)} words/sec` : "";
  statusText.textContent = `Step ${s.step} done in ${s.seconds.toFixed(0)}s${tps}`;
  statusText.className = "status-text";
});

window.workbench.on("agent:tool", ({ name, args }) => addToolChip(name, args));

window.workbench.on("agent:answer", ({ text }) => {
  if (text) addMsg("msg-agent", text);
  setBusy(false);
});

window.workbench.on("agent:approval", data => addApprovalCard(data));

/* ---------- user actions ---------- */

async function chooseFolder() {
  const folder = await window.workbench.chooseFolder();
  if (!folder) return;
  folderChosen = true;
  folderLabel.textContent = folder;
  folderLabel.title = folder;
  emptyFolderBtn.hidden = true;
  starters.hidden = false;
  setBusy(false, "Ready");
  setMeter(0, currentCtx);
}

async function send(textOverride) {
  const text = (textOverride ?? input.value).trim();
  if (!text || busy) return;
  if (!folderChosen) { addMsg("msg-error", "Choose a project folder first."); return; }
  emptyState.remove?.();
  addMsg("msg-user", text);
  input.value = "";
  setBusy(true, "Working");
  const result = await window.workbench.sendMessage(text);
  if (!result.ok) {
    addMsg("msg-error", friendlyError(result.error));
    setBusy(false);
  }
}

function friendlyError(err) {
  if (/fetch failed|ECONNREFUSED/i.test(err)) {
    return "Can't reach the AI on this computer. Open the Ollama app, wait a few seconds, then try again.";
  }
  return "Something went wrong: " + err;
}

folderBtn.addEventListener("click", chooseFolder);
emptyFolderBtn.addEventListener("click", chooseFolder);
sendBtn.addEventListener("click", () => send());
stopBtn.addEventListener("click", () => window.workbench.stop());
input.addEventListener("keydown", e => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
});
newChatBtn.addEventListener("click", async () => {
  await window.workbench.newChat();
  chat.querySelectorAll(".msg, .tool-chip, .approval").forEach(el => el.remove());
  setMeter(0, currentCtx);
  setBusy(false, "New chat started");
});
autoApprove.addEventListener("change", () =>
  window.workbench.setSettings({ autoApprove: autoApprove.checked }));
modelSelect.addEventListener("change", () =>
  window.workbench.setSettings({ model: modelSelect.value }));
ctxSelect.addEventListener("change", () => {
  currentCtx = parseInt(ctxSelect.value, 10);
  window.workbench.setSettings({ numCtx: currentCtx });
  setMeter(0, currentCtx);
});

document.querySelectorAll(".starter").forEach(btn =>
  btn.addEventListener("click", () => send(btn.textContent)));

/* ---------- Quick / Smart modes ---------- */

const modeQuick = document.getElementById("modeQuick");
const modeSmart = document.getElementById("modeSmart");
let pulling = false;

function markMode(mode) {
  modeQuick.classList.toggle("active", mode === "quick");
  modeSmart.classList.toggle("active", mode === "smart");
}

async function setMode(mode) {
  if (busy || pulling) return;
  const res = await window.workbench.setMode(mode);
  if (!res.ok) { addMsg("msg-error", res.error); return; }

  if (res.needsPull) {
    offerDownload(mode, res.needsPull);
    return; // stay on current mode until the download finishes
  }
  markMode(mode);
  modelSelect.value = res.model;
  statusBar.hidden = false;
  statusText.className = "status-text";
  statusText.textContent = mode === "smart"
    ? "Smart mode on — better answers, expect slower replies"
    : "Quick mode on — fast replies";
}

function offerDownload(mode, modelName) {
  const card = document.createElement("div");
  card.className = "approval";
  const head = document.createElement("div");
  head.className = "approval-title";
  head.textContent = "Smart mode needs a one-time download";
  const p = document.createElement("div");
  p.textContent = `The smarter model (${modelName}) is about 18 GB and downloads once. ` +
    `You can keep working in Quick mode while it downloads.`;
  const bar = document.createElement("div");
  bar.className = "dl-bar";
  const fill = document.createElement("div");
  bar.appendChild(fill);
  bar.hidden = true;
  const actions = document.createElement("div");
  actions.className = "approval-actions";
  const go = document.createElement("button");
  go.className = "btn btn-primary";
  go.textContent = "Download now";
  const skip = document.createElement("button");
  skip.className = "btn btn-deny";
  skip.textContent = "Not now";

  go.addEventListener("click", async () => {
    pulling = true;
    actions.remove();
    bar.hidden = false;
    const res = await window.workbench.pullModel(modelName);
    pulling = false;
    if (res.ok) {
      head.textContent = "Smart model ready";
      p.textContent = "Smart mode is now on.";
      bar.remove();
      markMode(mode);
      statusText.textContent = "Smart mode on — better answers, expect slower replies";
    } else {
      head.textContent = "Download didn't finish";
      p.textContent = friendlyError(res.error) +
        " You can also run:  ollama pull " + modelName;
      bar.remove();
    }
  });
  skip.addEventListener("click", () => card.remove());

  actions.append(go, skip);
  card.append(head, p, bar, actions);
  chat.appendChild(card);
  chat.scrollTop = chat.scrollHeight;

  window.workbench.on("agent:pull", d => {
    if (d.total) {
      const pct = Math.round((d.completed / d.total) * 100);
      fill.style.width = pct + "%";
      statusBar.hidden = false;
      statusText.className = "status-text";
      statusText.textContent =
        `Downloading smart model — ${pct}% (${(d.completed / 1e9).toFixed(1)} of ${(d.total / 1e9).toFixed(1)} GB)`;
    } else if (d.status === "done") {
      fill.style.width = "100%";
      statusText.textContent = "Smart model downloaded";
    }
  });
}

modeQuick.addEventListener("click", () => setMode("quick"));
modeSmart.addEventListener("click", () => setMode("smart"));

/* ---------- boot: populate models ---------- */

(async () => {
  const res = await window.workbench.listModels();
  modelSelect.replaceChildren();
  if (res.ok && res.models.length) {
    for (const m of res.models) {
      const opt = document.createElement("option");
      opt.value = opt.textContent = m;
      modelSelect.appendChild(opt);
    }
    const preferred = res.models.find(m => m.startsWith("qwen3")) || res.models[0];
    modelSelect.value = preferred;
    window.workbench.setSettings({ model: preferred });
  } else {
    const opt = document.createElement("option");
    opt.textContent = "Ollama not running";
    modelSelect.appendChild(opt);
  }
})();
