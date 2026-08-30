"use strict";

const bridge = globalThis.companion || {
  protocol: globalThis.BILI_COMPANION,
  async getStatus() { return { installed: false, message: "当前页面不是桌面软件运行环境。" }; },
  async listModels() { return []; },
  async listResults() { return []; },
  async updateResult() { throw new Error("请在打包后的桌面软件中编辑结果。 "); },
  async downloadModel() { throw new Error("请在官方桌面软件中使用模型管理。 "); },
  async uninstallModel() { throw new Error("请在官方桌面软件中使用模型管理。 "); },
  async startTask() { throw new Error("识别引擎尚未连接。请使用打包后的桌面软件。 "); },
  async pauseTask() {},
  async resumeTask() {},
  async cancelTask() {},
  async retryTask() {},
  on() {},
  getFilePath() { return null; },
};
const protocol = bridge.protocol || globalThis.BILI_COMPANION;

const state = {
  file: null,
  fileUrl: "",
  isVideo: true,
  region: protocol.presetRegion("bottom"),
  preset: "bottom",
  mode: "both",
  language: "",
  task: null,
  result: null,
  resultDirty: false,
  trackKind: "ocr",
  models: [],
  handoffContext: null,
  storedResults: [],
  taskHistory: [],
  modelProgress: {},
};

const $ = (id) => document.getElementById(id);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function showToast(message) {
  const node = $("toast");
  node.textContent = String(message || "");
  node.hidden = !node.textContent;
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => { node.hidden = true; }, 3500);
}

function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024 * 1024) return `${Math.max(1, Math.round(value / 1024))} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
  return `${(value / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

function formatDuration(seconds) {
  const value = Math.max(0, Math.floor(Number(seconds) || 0));
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  const rest = String(value % 60).padStart(2, "0");
  return `${hours ? `${hours}:` : ""}${String(minutes).padStart(2, "0")}:${rest}`;
}

function formatDate(value) {
  const date = new Date(Number(value) || 0);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString();
}

function mediaIsVideo(file) {
  if (String(file?.type || "").startsWith("video/")) return true;
  if (String(file?.type || "").startsWith("audio/")) return false;
  return !/\.(mp3|wav|m4a|aac|flac|ogg)$/i.test(file?.name || "");
}

function selectedVideoRect() {
  const stage = $("playerStage").getBoundingClientRect();
  const media = (state.isVideo ? $("videoPlayer") : $("audioPlayer")).getBoundingClientRect();
  return {
    left: media.left - stage.left,
    top: media.top - stage.top,
    width: media.width || stage.width,
    height: media.height || stage.height,
  };
}

function paintRegion() {
  if (!state.isVideo || !state.file) return;
  const box = $("regionBox");
  const rect = selectedVideoRect();
  box.style.left = `${rect.left + state.region.x * rect.width}px`;
  box.style.top = `${rect.top + state.region.y * rect.height}px`;
  box.style.width = `${state.region.width * rect.width}px`;
  box.style.height = `${state.region.height * rect.height}px`;
}

function setPreset(name) {
  state.preset = name;
  if (name !== "custom") state.region = protocol.presetRegion(name);
  for (const button of document.querySelectorAll(".preset-button")) {
    button.classList.toggle("active", button.dataset.preset === name);
  }
  $("regionHint").textContent = name === "custom"
    ? "这是自定义区域。拖动边框或四角手柄继续调整。"
    : "拖动边框或四角手柄，覆盖整段视频中的字幕。";
  paintRegion();
}

function setMedia(file) {
  if (state.fileUrl) URL.revokeObjectURL(state.fileUrl);
  state.file = file;
  state.fileUrl = URL.createObjectURL(file);
  state.isVideo = mediaIsVideo(file);
  state.task = null;
  state.result = null;

  const video = $("videoPlayer");
  const audio = $("audioPlayer");
  video.pause();
  audio.pause();
  video.removeAttribute("src");
  audio.removeAttribute("src");
  if (state.isVideo) {
    video.hidden = false;
    audio.hidden = true;
    $("audioPlaceholder").hidden = true;
    $("regionBox").hidden = false;
    video.src = state.fileUrl;
    video.load();
  } else {
    video.hidden = true;
    audio.hidden = false;
    $("audioPlaceholder").hidden = false;
    $("regionBox").hidden = true;
    state.mode = "asr";
    $("recognitionMode").value = "asr";
    $("recognitionMode").disabled = true;
    audio.src = state.fileUrl;
    audio.load();
  }
  if (state.isVideo) {
    $("recognitionMode").disabled = false;
  }
  $("emptyMedia").hidden = true;
  $("mediaWorkspace").hidden = false;
  $("mediaName").textContent = file.name;
  $("mediaInfo").textContent = `${formatBytes(file.size)} · ${state.isVideo ? "视频" : "音频"}`;
  $("startButton").disabled = false;
  setPreset(state.preset);
  renderResult(null);
  renderTask(null);
}

function resetMedia() {
  if (state.task && ["running", "paused", "queued"].includes(state.task.state)) {
    showToast("当前任务仍在运行，请先取消任务。");
    return;
  }
  if (state.fileUrl) URL.revokeObjectURL(state.fileUrl);
  state.file = null;
  state.fileUrl = "";
  state.result = null;
  state.task = null;
  $("mediaInput").value = "";
  $("emptyMedia").hidden = false;
  $("mediaWorkspace").hidden = true;
  renderTask(null);
  renderResult(null);
}

function updateMediaInfo(event) {
  const target = event.currentTarget;
  const duration = Number(target.duration) || 0;
  if (state.file) $("mediaInfo").textContent = `${formatBytes(state.file.size)} · ${formatDuration(duration)} · ${state.isVideo ? "视频" : "音频"}`;
  paintRegion();
}

function regionInteraction(event) {
  if (!state.isVideo || !state.file) return;
  const handle = event.target.closest?.("[data-handle]")?.dataset.handle || "move";
  const rect = selectedVideoRect();
  const start = { ...state.region, pointerX: event.clientX, pointerY: event.clientY };
  event.preventDefault();

  const move = (moveEvent) => {
    const dx = (moveEvent.clientX - start.pointerX) / Math.max(1, rect.width);
    const dy = (moveEvent.clientY - start.pointerY) / Math.max(1, rect.height);
    let next = { x: start.x, y: start.y, width: start.width, height: start.height };
    if (handle === "move") {
      next.x += dx;
      next.y += dy;
    } else {
      if (handle.includes("w")) {
        next.x += dx;
        next.width -= dx;
      } else if (handle.includes("e")) {
        next.width += dx;
      }
      if (handle.includes("n")) {
        next.y += dy;
        next.height -= dy;
      } else if (handle.includes("s")) {
        next.height += dy;
      }
    }
    state.region = protocol.normalizeRegion(next);
    state.preset = "custom";
    for (const button of document.querySelectorAll(".preset-button")) {
      button.classList.toggle("active", button.dataset.preset === "custom");
    }
    paintRegion();
  };
  const stop = () => {
    document.removeEventListener("pointermove", move);
    document.removeEventListener("pointerup", stop);
  };
  document.addEventListener("pointermove", move);
  document.addEventListener("pointerup", stop, { once: true });
}

function currentTaskConfig() {
  return {
    filePath: bridge.getFilePath(state.file),
    fileName: state.file?.name || "",
    mode: state.mode,
    language: state.language.trim(),
    region: state.region,
    videoWidth: state.isVideo ? Number($("videoPlayer").videoWidth) || 0 : 0,
    videoHeight: state.isVideo ? Number($("videoPlayer").videoHeight) || 0 : 0,
    context: state.handoffContext || { kind: "local" },
    returnToExtension: Boolean(state.handoffContext?.returnToExtension),
  };
}

async function startRecognition() {
  if (!state.file) return;
  const config = currentTaskConfig();
  if (!config.filePath) {
    showToast("请使用打包后的桌面软件启动识别。");
    return;
  }
  const button = $("startButton");
  button.disabled = true;
  button.textContent = "正在启动…";
  try {
    const task = await bridge.startTask(config);
    // 同一个桌面进程里后续新任务是用户独立启动的，不再继承这次回传授权。
    state.handoffContext = null;
    state.task = protocol.normalizeTask(task);
    renderTask(state.task);
  } catch (error) {
    showToast(error.message || "识别任务启动失败。");
  } finally {
    button.disabled = Boolean(state.task && ["queued", "running", "paused"].includes(state.task.state));
    button.textContent = "开始识别";
  }
}

function renderTask(task) {
  state.task = task ? protocol.normalizeTask(task) : null;
  const card = $("taskCard");
  const active = state.task && ["queued", "running", "paused"].includes(state.task.state);
  const failed = state.task?.state === "failed";
  card.hidden = !state.task || (!active && !failed);
  if (!state.task) return;
  $("taskTitle").textContent = failed ? "识别失败" : state.task.state === "paused" ? "任务已暂停" : "正在识别";
  $("taskPercent").textContent = `${state.task.percent}%`;
  $("taskMessage").textContent = state.task.error || state.task.message || state.task.phase || "正在准备…";
  $("taskProgress").style.width = `${state.task.percent}%`;
  $("pauseButton").textContent = state.task.state === "paused" ? "继续" : "暂停";
  $("pauseButton").hidden = !active;
  $("cancelButton").hidden = !active;
  $("retryButton").hidden = !failed;
}

function renderTaskHistory(tasks) {
  state.taskHistory = (Array.isArray(tasks) ? tasks : [])
    .map((task) => protocol.normalizeTask(task))
    .filter((task) => task.id);
  const section = $("taskHistory");
  const list = $("taskHistoryList");
  section.hidden = state.taskHistory.length === 0;
  list.textContent = "";
  for (const task of state.taskHistory.slice(0, 20)) {
    const row = document.createElement("div");
    row.className = "task-history-row";
    const title = document.createElement("span");
    title.className = "history-title";
    title.textContent = task.title || task.fileName || "本地媒体";
    const stateText = document.createElement("span");
    stateText.className = `task-history-state task-history-${task.state}`;
    stateText.textContent = {
      queued: "排队中",
      running: "处理中",
      paused: "已暂停",
      completed: "已完成",
      canceled: "已取消",
      failed: "失败",
    }[task.state] || task.state;
    row.append(title, stateText);
    list.appendChild(row);
  }
}

function trackEntries() {
  return state.result?.tracks?.[state.trackKind]?.segments || [];
}

function renderResult(result) {
  const sameResult = state.result?.sourceId && state.result.sourceId === result?.sourceId;
  state.result = result ? protocol.normalizeTranscript(result) : null;
  if (!sameResult) state.resultDirty = false;
  const card = $("resultCard");
  card.hidden = !state.result;
  if (!state.result) {
    $("saveResultButton").disabled = true;
    renderResultHistory();
    return;
  }
  const available = Object.entries(state.result.tracks || {})
    .filter(([, track]) => track?.segments?.length);
  if (!available.some(([kind]) => kind === state.trackKind)) state.trackKind = available[0]?.[0] || "ocr";
  $("resultMeta").textContent = `${state.result.title} · ${formatDate(state.result.updatedAt)}`;
  const tabs = $("trackTabs");
  tabs.textContent = "";
  for (const [kind, track] of available) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "track-tab";
    button.classList.toggle("active", kind === state.trackKind);
    button.textContent = `${kind === "ocr" ? "画面字幕 OCR" : "语音 ASR"} · ${track.segments.length}`;
    button.addEventListener("click", () => {
      state.trackKind = kind;
      renderResult(state.result);
    });
    tabs.appendChild(button);
  }
  const preview = $("resultPreview");
  preview.textContent = "";
  for (const entry of trackEntries().slice(0, 100)) {
    const row = document.createElement("div");
    row.className = "result-line";
    const time = document.createElement("span");
    time.className = "result-time";
    time.textContent = protocol.formatTimestamp(entry.start);
    const text = document.createElement("span");
    text.className = "result-text result-edit";
    text.contentEditable = "true";
    text.spellcheck = false;
    text.textContent = entry.text;
    text.addEventListener("input", () => {
      entry.text = text.textContent.trim();
      state.resultDirty = true;
      $("saveResultButton").disabled = false;
    });
    row.append(time, text);
    preview.appendChild(row);
  }
  if (trackEntries().length > 100) {
    const more = document.createElement("p");
    more.className = "muted";
    more.textContent = `仅预览前 100 条，共 ${trackEntries().length} 条；导出会包含全部字幕。`;
    preview.appendChild(more);
  }
  $("saveResultButton").disabled = !state.resultDirty;
  renderResultHistory();
}

function renderResultHistory() {
  const history = $("resultHistory");
  const list = $("resultHistoryList");
  const results = Array.isArray(state.storedResults) ? state.storedResults : [];
  history.hidden = results.length === 0;
  list.textContent = "";
  for (const result of results) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "history-row";
    button.classList.toggle("active", state.result?.sourceId === result.sourceId);
    const title = document.createElement("span");
    title.className = "history-title";
    title.textContent = result.title;
    const meta = document.createElement("span");
    meta.className = "history-meta";
    const count = Object.values(result.tracks || {})
      .reduce((total, track) => total + (track?.segments?.length || 0), 0);
    meta.textContent = `${result.fileName} · ${count} 条`;
    button.append(title, meta);
    button.addEventListener("click", () => renderResult(result));
    list.appendChild(button);
  }
}

function safeFilename(name) {
  return String(name || "transcript").replace(/[\\/:*?"<>|]/g, "_").slice(0, 100) || "transcript";
}

function downloadTrack(format) {
  if (!state.result) return;
  const track = state.result.tracks?.[state.trackKind];
  if (!track?.segments?.length) return;
  const text = protocol.serializeSubtitle(track, format, state.result.title);
  const blob = new Blob([text], { type: format === "vtt" ? "text/vtt;charset=utf-8" : "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${safeFilename(state.result.title)}-${state.trackKind}.${format}`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function renderModels(models) {
  state.models = Array.isArray(models) ? models : [];
  const list = $("modelList");
  list.textContent = "";
  if (!state.models.length) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = "桌面软件暂未返回模型列表。";
    list.appendChild(empty);
    return;
  }
  for (const model of state.models) {
    const progress = state.modelProgress[model.id];
    const downloading = model.downloading || progress?.state === "running";
    const row = document.createElement("div");
    row.className = "model-row";
    const info = document.createElement("div");
    const name = document.createElement("div");
    name.className = "model-name";
    name.textContent = model.label || model.id;
    const meta = document.createElement("div");
    meta.className = "model-meta";
    const sourceLabel = downloading
      ? (progress?.total ? `下载中 ${Math.round(progress.done / progress.total * 100)}%` : "准备下载…")
      : model.installed
      ? (model.sizeBytes ? formatBytes(model.sizeBytes) : "已安装")
      : model.sourceConfigured
        ? (model.sizeBytes ? formatBytes(model.sizeBytes) : "按需下载")
        : "发行包未配置下载源";
    meta.textContent = [model.kind === "ocr" ? "OCR" : "ASR", sourceLabel]
      .join(" · ");
    info.append(name, meta);
    const action = document.createElement("button");
    action.type = "button";
    action.className = "model-action";
    action.textContent = downloading
      ? "下载中…"
      : model.installed
      ? "卸载"
      : model.sourceConfigured
          ? "下载"
          : "未配置";
    action.disabled = downloading || (!model.installed && !model.sourceConfigured);
    action.addEventListener("click", async () => {
      action.disabled = true;
      try {
        if (model.installed) await bridge.uninstallModel(model.id);
        else await bridge.downloadModel(model.id);
        await refreshStatus();
      } catch (error) {
        showToast(error.message || "模型操作失败。");
        action.disabled = false;
      }
    });
    row.append(info, action);
    list.appendChild(row);
  }
}

async function refreshStoredResults() {
  try {
    const value = await bridge.listResults();
    const values = Array.isArray(value) ? value : value?.results;
    state.storedResults = (Array.isArray(values) ? values : [])
      .map((result) => {
        try { return protocol.normalizeTranscript(result); } catch (error) { return null; }
      })
      .filter(Boolean);
    if (!state.result && state.storedResults[0]) renderResult(state.storedResults[0]);
    else renderResultHistory();
  } catch (error) {
    state.storedResults = [];
    renderResultHistory();
  }
}

async function saveEditedResult() {
  if (!state.result || !state.resultDirty) return;
  const button = $("saveResultButton");
  button.disabled = true;
  try {
    const saved = await bridge.updateResult(state.result);
    const normalized = protocol.normalizeTranscript(saved);
    state.result = normalized;
    state.storedResults = [
      normalized,
      ...state.storedResults.filter((item) => item.sourceId !== normalized.sourceId),
    ];
    state.resultDirty = false;
    renderResult(normalized);
    showToast("字幕编辑已保存");
  } catch (error) {
    button.disabled = false;
    showToast(error.message || "字幕编辑保存失败。 ");
  }
}

async function refreshStatus() {
  try {
    const status = await bridge.getStatus();
    const installed = Boolean(status?.installed);
    $("connectionBadge").textContent = !installed
      ? "未连接软件"
      : status?.engineReady
        ? "本地引擎已连接"
        : "软件已安装 · 引擎未就绪";
    if (status?.version) $("versionText").textContent = `v${status.version}`;
    renderModels(status?.models || []);
    renderTaskHistory(status?.taskHistory || []);
    if (status?.activeTask) renderTask(status.activeTask);
  } catch (error) {
    $("connectionBadge").textContent = "未连接引擎";
    showToast(error.message || "桌面引擎状态读取失败。");
  }
}

function wireBridgeEvents() {
  bridge.on("taskChanged", (task) => {
    renderTask(task);
    const current = protocol.normalizeTask(task);
    state.taskHistory = [
      current,
      ...state.taskHistory.filter((item) => item.id !== current.id),
    ].sort((left, right) => right.updatedAt - left.updatedAt);
    renderTaskHistory(state.taskHistory);
  });
  bridge.on("transcriptReady", (result) => {
    try {
      const normalized = protocol.normalizeTranscript(result);
      state.storedResults = [
        normalized,
        ...state.storedResults.filter((item) => item.sourceId !== normalized.sourceId),
      ];
      renderResult(normalized);
    } catch (error) {
      showToast(error.message || "识别结果无效。");
    }
  });
  bridge.on("statusChanged", (status) => {
    $("connectionBadge").textContent = status?.installed ? "本地引擎已连接" : "未连接引擎";
    renderModels(status?.models || []);
  });
  bridge.on("modelProgress", (progress) => {
    if (!progress?.modelId) return;
    state.modelProgress[progress.modelId] = progress;
    if (progress.state === "failed") showToast(progress.error || "模型下载失败。");
    renderModels(state.models);
  });
  bridge.on("handoffContext", (context) => {
    state.handoffContext = context;
    if (context?.title) showToast(`已关联：${context.title}`);
  });
}

function setup() {
  $("mediaInput").addEventListener("change", (event) => {
    const file = event.target.files?.[0];
    if (file) setMedia(file);
  });
  $("replaceMediaBtn").addEventListener("click", () => $("mediaInput").click());
  $("startButton").addEventListener("click", startRecognition);
  $("recognitionMode").addEventListener("change", (event) => { state.mode = event.target.value; });
  $("languageInput").addEventListener("input", (event) => { state.language = event.target.value; });
  for (const button of document.querySelectorAll(".preset-button")) {
    button.addEventListener("click", () => setPreset(button.dataset.preset));
  }
  $("regionBox").addEventListener("pointerdown", regionInteraction);
  $("videoPlayer").addEventListener("loadedmetadata", updateMediaInfo);
  $("audioPlayer").addEventListener("loadedmetadata", updateMediaInfo);
  window.addEventListener("resize", paintRegion);
  $("pauseButton").addEventListener("click", async () => {
    try {
      if (state.task?.state === "paused") await bridge.resumeTask(state.task.id);
      else await bridge.pauseTask(state.task?.id);
    } catch (error) { showToast(error.message); }
  });
  $("cancelButton").addEventListener("click", async () => {
    try { await bridge.cancelTask(state.task?.id); } catch (error) { showToast(error.message); }
  });
  $("retryButton").addEventListener("click", async () => {
    try { await bridge.retryTask(state.task?.id); } catch (error) { showToast(error.message); }
  });
  $("refreshModelsButton").addEventListener("click", refreshStatus);
  $("saveResultButton").addEventListener("click", saveEditedResult);
  for (const button of document.querySelectorAll(".export-button")) {
    button.addEventListener("click", () => downloadTrack(button.dataset.format));
  }
  wireBridgeEvents();
  refreshStatus();
  refreshStoredResults();
}

document.addEventListener("DOMContentLoaded", setup);
