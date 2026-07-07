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
  win.loadFile(path.join(__dirname, "renderer", "index.html"));
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
