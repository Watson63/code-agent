const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("workbench", {
  chooseFolder: () => ipcRenderer.invoke("choose-folder"),
  listModels: () => ipcRenderer.invoke("list-models"),
  setSettings: patch => ipcRenderer.invoke("set-settings", patch),
  sendMessage: text => ipcRenderer.invoke("send-message", text),
  newChat: () => ipcRenderer.invoke("new-chat"),
  stop: () => ipcRenderer.invoke("stop"),
  respondApproval: (id, approved) => ipcRenderer.send("approval-response", { id, approved }),
  on: (channel, handler) => {
    const allowed = ["agent:thinking", "agent:stats", "agent:tool", "agent:answer", "agent:approval"];
    if (allowed.includes(channel)) {
      ipcRenderer.on(channel, (_e, data) => handler(data));
    }
  },
});
