"use strict";

// 打包后的桌面 exe 同时承担 GUI 和 Native Messaging host 两个入口。
// Chrome/Edge 启动 host 时会传 --native-host；此时不能创建 Electron 窗口，
// 而是直接进入 stdio broker。broker 再用同一个 exe（不带该参数）启动 GUI。
if (process.argv.includes("--native-host")) {
  require("./native-host.cjs");
} else {

const fs = require("node:fs");
const path = require("node:path");
const net = require("node:net");
const { app, BrowserWindow, ipcMain } = require("electron");

// 自动化验收需要使用一次性的用户目录和假引擎，避免碰到开发者的真实数据。
// 这些覆盖项只改变进程内部路径，不改变扩展与伴生程序之间的消息协议。
if (process.env.VIDEO_DIGEST_TEST_USER_DATA) {
  app.setPath("userData", path.resolve(process.env.VIDEO_DIGEST_TEST_USER_DATA));
}

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
const { createEngine } = require("./engine.cjs");
const { ModelStore } = require("./model-store.cjs");

const APP_VERSION = "0.1.0";
const TASK_HISTORY_LIMIT = 100;

let mainWindow = null;
let nativeSocket = null;
let nativeBuffer = "";
let handoffContext = null;
const tasks = new Map();

function argValue(prefix) {
  const item = process.argv.find((value) => value.startsWith(prefix));
  return item ? item.slice(prefix.length) : "";
}

function decodeHandoff(value) {
  if (!value) return null;
  try { return JSON.parse(Buffer.from(value, "base64url").toString("utf8")); } catch (error) { return null; }
}

function userDataPath(...parts) {
  return path.join(app.getPath("userData"), ...parts);
}

function safeFilePart(value, fallback = "result") {
  const clean = String(value || "")
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .replace(/^\.+/, "")
    .slice(0, 180);
  return clean || fallback;
}

function resultFilePath(sourceId) {
  return path.join(userDataPath("results"), `${safeFilePart(sourceId)}.json`);
}

async function listStoredResults() {
  const directory = userDataPath("results");
  if (!fs.existsSync(directory)) return [];
  const results = [];
  for (const file of fs.readdirSync(directory)) {
    if (!file.endsWith(".json")) continue;
    try {
      const value = protocol.normalizeTranscript(
        JSON.parse(fs.readFileSync(path.join(directory, file), "utf8")),
      );
      results.push(value);
    } catch (error) {
      // 损坏的历史文件不应阻塞桌面软件启动或其他结果的显示。
    }
  }
  return results.sort((left, right) => right.updatedAt - left.updatedAt);
}

async function findStoredResult(sourceId) {
  const wanted = String(sourceId || "");
  return (await listStoredResults()).find((result) => result.sourceId === wanted) || null;
}

function taskHistoryFile() {
  return userDataPath("task-history.json");
}

function readTaskHistory() {
  try {
    const value = JSON.parse(fs.readFileSync(taskHistoryFile(), "utf8"));
    return Array.isArray(value) ? value : [];
  } catch (error) {
    return [];
  }
}

function persistTask(task) {
  const value = taskView(task);
  const history = [value, ...readTaskHistory().filter((item) => item.id !== value.id)]
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .slice(0, TASK_HISTORY_LIMIT);
  fs.mkdirSync(path.dirname(taskHistoryFile()), { recursive: true });
  fs.writeFileSync(taskHistoryFile(), JSON.stringify(history, null, 2), "utf8");
}

function listTaskHistory() {
  return readTaskHistory()
    .map((task) => protocol.normalizeTask(task))
    .filter((task) => task.id)
    .sort((left, right) => right.updatedAt - left.updatedAt);
}

function updateStoredResult(input) {
  const current = protocol.normalizeTranscript(input);
  const result = protocol.normalizeTranscript({ ...current, updatedAt: Date.now() });
  fs.mkdirSync(userDataPath("results"), { recursive: true });
  fs.writeFileSync(resultFilePath(result.sourceId), JSON.stringify(result, null, 2), "utf8");
  return result;
}

const modelStore = new ModelStore({
  root: userDataPath("models"),
  stateFile: userDataPath("model-state.json"),
  sourceFiles: [
    process.env.VIDEO_DIGEST_MODEL_SOURCES_FILE,
    userDataPath("model-sources.json"),
    app.isPackaged
      ? path.join(process.resourcesPath, "model-sources.json")
      : path.join(__dirname, "model-sources.json"),
  ].filter(Boolean),
  allowInsecureLocalhost: process.env.VIDEO_DIGEST_TEST_ALLOW_HTTP === "1",
});
const engine = createEngine({
  engineDir: process.env.VIDEO_DIGEST_ENGINE_DIR || (app.isPackaged
    ? path.join(process.resourcesPath, "engine")
    : path.join(__dirname, "engine")),
});

function sendRenderer(event, value) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(`companion:${event}`, value);
}

function writeNative(message) {
  if (!nativeSocket || nativeSocket.destroyed) return;
  nativeSocket.write(`${JSON.stringify(message)}\n`);
}

function sendNativeEvent(event, payload) {
  writeNative({
    protocol: protocol.PROTOCOL,
    version: protocol.VERSION,
    type: "event",
    event,
    payload,
  });
}

async function downloadModel(modelId) {
  const progress = (value) => sendRenderer("modelProgress", {
    modelId,
    state: "running",
    ...value,
  });
  progress({ done: 0, total: 0, message: "正在准备模型下载…" });
  try {
    const model = await modelStore.download(modelId, progress);
    sendRenderer("modelProgress", { modelId, state: "completed", done: 1, total: 1, model });
    return { model };
  } catch (error) {
    sendRenderer("modelProgress", {
      modelId,
      state: "failed",
      error: error.message || "模型下载失败。",
    });
    throw error;
  }
}

function taskView(task) {
  return protocol.normalizeTask({
    ...task,
    title: task.config?.fileName || task.title,
    fileName: task.config?.fileName || task.fileName,
  });
}

function publishTask(task) {
  const value = taskView(task);
  if (task.state !== "running") persistTask(task);
  sendRenderer("taskChanged", value);
  sendNativeEvent(protocol.EVENTS.TASK_CHANGED, { task: value });
}

function activeTask() {
  return [...tasks.values()].find((task) => ["queued", "running", "paused"].includes(task.state)) || null;
}

async function status() {
  let engineManifest = null;
  let engineMessage = "桌面软件已安装，但当前版本没有包含本地识别引擎。";
  try {
    engineManifest = engine.readManifest();
    if (engineManifest) engineMessage = "桌面软件已就绪。";
  } catch (error) {
    engineMessage = error.message || "识别引擎配置损坏，请重新安装桌面软件。";
  }
  return {
    installed: true,
    running: true,
    engineReady: Boolean(engineManifest),
    message: engineMessage,
    version: APP_VERSION,
    models: await modelStore.list(),
    activeTask: activeTask() ? taskView(activeTask()) : null,
    taskHistory: listTaskHistory(),
  };
}

function taskError(task, error) {
  task.state = error.code === "TASK_CANCELED" ? "canceled" : "failed";
  task.error = error.message || "识别失败。";
  task.message = task.error;
  task.updatedAt = Date.now();
  publishTask(task);
}

async function runTask(task) {
  task.state = "running";
  task.phase = "prepare";
  task.message = "正在准备本地识别引擎…";
  publishTask(task);
  try {
    const modelPaths = await modelStore.pathsForMode(task.mode);
    const result = await engine.recognize({ ...task.config, modelPaths }, {
      signal: task.controller.signal,
      controller: task.controller,
      onProgress: ({ done, total, phase, message }) => {
        task.done = Number(done) || 0;
        task.total = Number(total) || 0;
        task.phase = phase || task.phase;
        task.message = message || task.message;
        task.updatedAt = Date.now();
        publishTask(task);
      },
    });
    const outputDir = userDataPath("results");
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(resultFilePath(result.sourceId), JSON.stringify(result, null, 2), "utf8");
    task.state = "completed";
    task.done = task.total || 1;
    task.total = task.total || 1;
    task.percent = 100;
    task.message = "识别完成";
    task.updatedAt = Date.now();
    task.result = result;
    publishTask(task);
    sendRenderer("transcriptReady", result);
    if (task.config.returnToExtension) {
      sendNativeEvent(protocol.EVENTS.TRANSCRIPT_READY, { result });
    }
  } catch (error) {
    taskError(task, error);
  }
}

async function startTask(configInput) {
  const config = configInput && typeof configInput === "object" ? configInput : {};
  const sourceId = String(config.sourceId || protocol.createId("local")).slice(0, 200);
  const task = {
    id: protocol.createId("task"),
    sourceId,
    mode: protocol.RECOGNITION_MODES.includes(config.mode) ? config.mode : "both",
    state: "queued",
    done: 0,
    total: 0,
    phase: "queued",
    message: "已加入任务",
    updatedAt: Date.now(),
    controller: new AbortController(),
    config: {
      ...config,
      sourceId,
      mode: protocol.RECOGNITION_MODES.includes(config.mode) ? config.mode : "both",
      region: protocol.normalizeRegion(config.region),
    },
  };
  tasks.set(task.id, task);
  publishTask(task);
  void runTask(task);
  return taskView(task);
}

async function controlTask(taskId, action) {
  const task = tasks.get(String(taskId || ""));
  if (!task) throw new Error("任务不存在或已结束。");
  if (action === "pause" && task.state === "running") {
    task.state = "paused";
    task.controller.paused = true;
    task.controller.pause?.();
    task.message = "已暂停";
  } else if (action === "resume" && task.state === "paused") {
    task.state = "running";
    task.controller.paused = false;
    task.controller.resume?.();
    task.message = "继续识别…";
  } else if (action === "cancel" && ["queued", "running", "paused"].includes(task.state)) {
    task.controller.canceled = true;
    task.controller.abort();
    task.state = "canceled";
    task.message = "已取消";
  } else if (action === "retry" && task.state === "failed") {
    task.controller = new AbortController();
    task.state = "queued";
    task.done = 0;
    task.total = 0;
    task.error = "";
    task.message = "重新加入任务";
    task.updatedAt = Date.now();
    publishTask(task);
    void runTask(task);
    return taskView(task);
  }
  task.updatedAt = Date.now();
  publishTask(task);
  return taskView(task);
}

async function command(action, payload = {}) {
  switch (action) {
    case protocol.ACTIONS.STATUS: return status();
    case protocol.ACTIONS.OPEN:
      handoffContext = {
        ...(payload.context || {}),
        returnToExtension: Boolean(payload.returnToExtension),
      };
      sendRenderer("handoffContext", handoffContext);
      return { opened: true };
    case protocol.ACTIONS.LIST_MODELS: return { models: await modelStore.list() };
    case protocol.ACTIONS.DOWNLOAD_MODEL: return downloadModel(payload.modelId);
    case protocol.ACTIONS.UNINSTALL_MODEL: return modelStore.uninstall(payload.modelId);
    case protocol.ACTIONS.START_TASK: return startTask(payload);
    case protocol.ACTIONS.LIST_TRANSCRIPTS: return { results: await listStoredResults() };
    case protocol.ACTIONS.GET_TRANSCRIPT: return { result: await findStoredResult(payload.sourceId) };
    case protocol.ACTIONS.DELETE_TRANSCRIPT:
      fs.rmSync(resultFilePath(payload.sourceId), { force: true });
      return { success: true };
    case protocol.ACTIONS.UPDATE_TRANSCRIPT: return updateStoredResult(payload.result || payload);
    case protocol.ACTIONS.LIST_TASKS: return { tasks: listTaskHistory() };
    case protocol.ACTIONS.PAUSE_TASK: return controlTask(payload.taskId, "pause");
    case protocol.ACTIONS.RESUME_TASK: return controlTask(payload.taskId, "resume");
    case protocol.ACTIONS.CANCEL_TASK: return controlTask(payload.taskId, "cancel");
    case protocol.ACTIONS.RETRY_TASK: return controlTask(payload.taskId, "retry");
    default: throw new Error("未知的桌面软件请求。");
  }
}

async function handleNativeRequest(message) {
  if (!protocol.isProtocolMessage(message) || message.type !== "request") return;
  try {
    const payload = await command(message.action, message.payload || {});
    writeNative({ protocol: protocol.PROTOCOL, version: protocol.VERSION, type: "response", requestId: message.requestId, success: true, payload });
  } catch (error) {
    writeNative({ protocol: protocol.PROTOCOL, version: protocol.VERSION, type: "error", requestId: message.requestId, success: false, error: error.code || "COMPANION_REQUEST_FAILED", message: error.message });
  }
}

function connectNativeChannel(channel = argValue("--native-channel=")) {
  if (!channel) return;
  nativeSocket?.destroy();
  nativeSocket = net.createConnection(channel);
  nativeSocket.on("data", (chunk) => {
    nativeBuffer += String(chunk);
    const lines = nativeBuffer.split(/\r?\n/);
    nativeBuffer = lines.pop() || "";
    lines.forEach((line) => {
      try { void handleNativeRequest(JSON.parse(line)); } catch (error) {}
    });
  });
  nativeSocket.on("error", () => {});
  nativeSocket.on("close", () => { nativeSocket = null; });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 820,
    minHeight: 650,
    backgroundColor: "#f7f3f4",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      // preload 需要读取打包进 resources 的共享协议模块。Electron 的沙箱
      // preload 只允许极少数内置模块，会直接拒绝 node:path/本地 require。
      // 页面仍保持 contextIsolation 且不暴露 Node，只开放下方白名单 IPC。
      sandbox: false,
      preload: path.join(__dirname, "preload.cjs"),
    },
  });
  mainWindow.loadFile(path.join(__dirname, "index.html"));
  mainWindow.on("closed", () => { mainWindow = null; });
  if (handoffContext) mainWindow.webContents.once("did-finish-load", () => sendRenderer("handoffContext", handoffContext));
}

function registerIpc() {
  ipcMain.handle("companion:getStatus", () => status());
  ipcMain.handle("companion:listModels", async () => (await modelStore.list()));
  ipcMain.handle("companion:listResults", () => listStoredResults());
  ipcMain.handle("companion:listTasks", () => listTaskHistory());
  ipcMain.handle("companion:updateResult", (_event, result) => updateStoredResult(result));
  ipcMain.handle("companion:downloadModel", (_event, modelId) => command(protocol.ACTIONS.DOWNLOAD_MODEL, { modelId }));
  ipcMain.handle("companion:uninstallModel", (_event, modelId) => command(protocol.ACTIONS.UNINSTALL_MODEL, { modelId }));
  ipcMain.handle("companion:startTask", (_event, config) => {
    // 回传授权只属于这次从扩展发起的任务。消费掉一次后，用户在已经打开的
    // 桌面软件里继续选择其他文件时，不会误把独立任务回传到旧页面。
    const pendingHandoff = handoffContext;
    handoffContext = null;
    return startTask({
      ...config,
      context: pendingHandoff || config?.context,
      returnToExtension: Boolean(pendingHandoff?.returnToExtension || config?.returnToExtension),
    });
  });
  ipcMain.handle("companion:pauseTask", (_event, taskId) => controlTask(taskId, "pause"));
  ipcMain.handle("companion:resumeTask", (_event, taskId) => controlTask(taskId, "resume"));
  ipcMain.handle("companion:cancelTask", (_event, taskId) => controlTask(taskId, "cancel"));
  ipcMain.handle("companion:retryTask", (_event, taskId) => controlTask(taskId, "retry"));
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();
else {
  app.on("second-instance", (_event, argv) => {
    const encoded = argv.find((value) => value.startsWith("--handoff="));
    const context = decodeHandoff(encoded?.slice("--handoff=".length));
    if (context) {
      handoffContext = context;
      sendRenderer("handoffContext", handoffContext);
    }
    const channel = argv.find((value) => value.startsWith("--native-channel="));
    connectNativeChannel(channel?.slice("--native-channel=".length));
    mainWindow?.show();
    mainWindow?.focus();
  });
  app.whenReady().then(() => {
    handoffContext = decodeHandoff(argValue("--handoff="));
    registerIpc();
    createWindow();
    connectNativeChannel();
  });
  app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
}

}
