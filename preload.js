const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("workbench", {
  chooseFolder: () => ipcRenderer.invoke("choose-folder"),
  listModels: () => ipcRenderer.invoke("list-models"),
  setSettings: patch => ipcRenderer.invoke("set-settings", patch),
  sendMessage: text => ipcRenderer.invoke("send-message", text),
  setMode: mode => ipcRenderer.invoke("set-mode", mode),
  pullModel: name => ipcRenderer.invoke("pull-model", name),
  newChat: () => ipcRenderer.invoke("new-chat"),
  stop: () => ipcRenderer.invoke("stop"),
  respondApproval: (id, approved) => ipcRenderer.send("approval-response", { id, approved }),
  on: (channel, handler) => {
    const allowed = ["agent:thinking", "agent:stats", "agent:tool", "agent:answer",
                     "agent:approval", "agent:pull"];
    if (allowed.includes(channel)) {
      ipcRenderer.on(channel, (_e, data) => handler(data));
    }
  },
});
