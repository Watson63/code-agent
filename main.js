/**
 * main.js — Electron main process.
 * Owns the Agent instance and bridges it to the renderer over IPC.
 */

const { app, BrowserWindow, ipcMain, dialog } = require("electron");
const path = require("path");
const { Agent } = require("./agentCore");

let win = null;
let agent = null;
let settings = {
  workspace: null,
  model: "qwen3:8b",
  ollamaUrl: "http://localhost:11434",
  numCtx: 16384,
  autoApprove: false,
};

// approval requests waiting on a click in the UI
const pendingApprovals = new Map();
let approvalSeq = 0;

function createWindow() {
  win = new BrowserWindow({
    width: 1000,
    height: 760,
    minWidth: 720,
    minHeight: 520,
    backgroundColor: "#F7F5EF",
    title: "Workbench",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.removeMenu();

  // Find index.html even if the folder structure was flattened during unzip
  const fs = require("fs");
  const candidates = [
    path.join(__dirname, "renderer", "index.html"),
    path.join(__dirname, "index.html"),
    path.join(process.cwd(), "renderer", "index.html"),
  ];
  const found = candidates.find(p => fs.existsSync(p));
  if (!found) {
    dialog.showErrorBox(
      "Workbench can't find its interface files",
      "index.html was not found. Looked in:\n\n" + candidates.join("\n") +
      "\n\nMake sure the 'renderer' folder (with index.html, styles.css, " +
      "renderer.js) sits next to main.js, and that you run 'npm start' " +
      "from inside the agent-ui folder."
    );
    app.quit();
    return;
  }
  win.loadFile(found);
}

function makeAgent() {
  agent = new Agent({
    workspace: settings.workspace,
    model: settings.model,
    ollamaUrl: settings.ollamaUrl,
    numCtx: settings.numCtx,
    autoApprove: settings.autoApprove,
    hooks: {
      onThinking: (step, max) => win.webContents.send("agent:thinking", { step, max }),
      onStats: stats => win.webContents.send("agent:stats", stats),
      onToolCall: (name, args) => win.webContents.send("agent:tool", { name, args }),
      onAssistant: text => win.webContents.send("agent:answer", { text }),
      requestApproval: ({ kind, title, detail }) =>
        new Promise(resolve => {
          const id = ++approvalSeq;
          pendingApprovals.set(id, resolve);
          win.webContents.send("agent:approval", { id, kind, title, detail });
        }),
    },
  });
}

// ---- speed/intelligence modes ------------------------------------------------
// quick: fits entirely in the RTX 4070's 8GB VRAM -> fast (~40+ tok/s)
// smart: MoE model spanning VRAM + system RAM -> slower but much more capable
const MODE_PRESETS = {
  quick: { candidates: ["qwen3:8b", "qwen2.5-coder:7b", "qwen3:4b"] },
  smart: { candidates: ["qwen3:30b-a3b", "qwen3:30b"] },
};

async function installedModels() {
  const res = await fetch(`${settings.ollamaUrl}/api/tags`);
  const data = await res.json();
  return (data.models || []).map(m => m.name);
}

ipcMain.handle("set-mode", async (_e, mode) => {
  const preset = MODE_PRESETS[mode];
  if (!preset) return { ok: false, error: "Unknown mode" };
  let installed = [];
  try { installed = await installedModels(); }
  catch { return { ok: false, error: "Can't reach Ollama. Open the Ollama app and try again." }; }
  const match = preset.candidates.find(c =>
    installed.some(m => m === c || m.startsWith(c + ":") || m.startsWith(c + "-")));
  if (!match) {
    // model needs a one-time download
    return { ok: true, needsPull: preset.candidates[0] };
  }
  const full = installed.find(m => m === match || m.startsWith(match));
  settings.model = full;
  if (agent) agent.model = full;
  return { ok: true, model: full };
});

ipcMain.handle("pull-model", async (_e, name) => {
  try {
    const res = await fetch(`${settings.ollamaUrl}/api/pull`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: name, stream: true }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const decoder = new TextDecoder();
    let buf = "";
    for await (const chunk of res.body) {
      buf += decoder.decode(chunk, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.error) throw new Error(msg.error);
        win.webContents.send("agent:pull", {
          model: name,
          status: msg.status || "",
          completed: msg.completed || 0,
          total: msg.total || 0,
        });
      }
    }
    settings.model = name;
    if (agent) agent.model = name;
    win.webContents.send("agent:pull", { model: name, status: "done" });
    return { ok: true, model: name };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
});

// ---- IPC handlers -----------------------------------------------------------

ipcMain.handle("choose-folder", async () => {
  const result = await dialog.showOpenDialog(win, { properties: ["openDirectory"] });
  if (result.canceled || !result.filePaths.length) return null;
  settings.workspace = result.filePaths[0];
  makeAgent();
  return settings.workspace;
});

ipcMain.handle("list-models", async () => {
  try {
    const res = await fetch(`${settings.ollamaUrl}/api/tags`);
    const data = await res.json();
    return { ok: true, models: (data.models || []).map(m => m.name) };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
});

ipcMain.handle("set-settings", (_e, patch) => {
  Object.assign(settings, patch);
  if (agent) {
    agent.model = settings.model;
    agent.autoApprove = settings.autoApprove;
    agent.numCtx = settings.numCtx;
  }
  return settings;
});

ipcMain.handle("send-message", async (_e, text) => {
  if (!agent) return { ok: false, error: "Choose a project folder first." };
  try {
    await agent.send(text);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
});

ipcMain.handle("new-chat", () => { agent?.clear(); return true; });
ipcMain.handle("stop", () => { agent?.cancel(); return true; });

ipcMain.on("approval-response", (_e, { id, approved }) => {
  const resolve = pendingApprovals.get(id);
  if (resolve) { pendingApprovals.delete(id); resolve(!!approved); }
});

app.whenReady().then(createWindow);
app.on("window-all-closed", () => app.quit());
