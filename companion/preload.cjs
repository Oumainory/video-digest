"use strict";

const path = require("node:path");
const { contextBridge, ipcRenderer, webUtils } = require("electron");

function loadProtocol() {
  const candidates = [
    path.join(__dirname, "..", "lib", "companion-protocol.js"),
    path.join(__dirname, "lib", "companion-protocol.js"),
    process.resourcesPath && path.join(process.resourcesPath, "lib", "companion-protocol.js"),
  ].filter(Boolean);
  for (const file of candidates) {
    try { return require(file); } catch (error) {}
  }
  throw new Error("桌面软件缺少共享通信协议，请重新安装官方版本。");
}

const protocol = loadProtocol();

const events = new Set(["taskChanged", "transcriptReady", "statusChanged", "modelProgress", "handoffContext"]);

contextBridge.exposeInMainWorld("companion", {
  protocol: {
    PROTOCOL: protocol.PROTOCOL,
    VERSION: protocol.VERSION,
    HOST_NAME: protocol.HOST_NAME,
    TRACK_KINDS: protocol.TRACK_KINDS,
    RECOGNITION_MODES: protocol.RECOGNITION_MODES,
    TASK_STATES: protocol.TASK_STATES,
    normalizeRegion: protocol.normalizeRegion,
    presetRegion: protocol.presetRegion,
    normalizeTask: protocol.normalizeTask,
    normalizeTranscript: protocol.normalizeTranscript,
    formatTimestamp: protocol.formatTimestamp,
    serializeSubtitle: protocol.serializeSubtitle,
  },
  getStatus: () => ipcRenderer.invoke("companion:getStatus"),
  listModels: () => ipcRenderer.invoke("companion:listModels"),
  listResults: () => ipcRenderer.invoke("companion:listResults"),
  listTasks: () => ipcRenderer.invoke("companion:listTasks"),
  updateResult: (result) => ipcRenderer.invoke("companion:updateResult", result),
  downloadModel: (modelId) => ipcRenderer.invoke("companion:downloadModel", modelId),
  uninstallModel: (modelId) => ipcRenderer.invoke("companion:uninstallModel", modelId),
  startTask: (config) => ipcRenderer.invoke("companion:startTask", config),
  pauseTask: (taskId) => ipcRenderer.invoke("companion:pauseTask", taskId),
  resumeTask: (taskId) => ipcRenderer.invoke("companion:resumeTask", taskId),
  cancelTask: (taskId) => ipcRenderer.invoke("companion:cancelTask", taskId),
  retryTask: (taskId) => ipcRenderer.invoke("companion:retryTask", taskId),
  getFilePath: (file) => {
    try {
      return webUtils.getPathForFile(file);
    } catch (error) {
      return file?.path || null;
    }
  },
  on(event, listener) {
    if (!events.has(event) || typeof listener !== "function") return () => {};
    const handler = (_event, value) => listener(value);
    ipcRenderer.on(`companion:${event}`, handler);
    return () => ipcRenderer.removeListener(`companion:${event}`, handler);
  },
});
