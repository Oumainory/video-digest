/**
 * 扩展与官方桌面伴生软件共用的协议与本地识别结果模型。
 *
 * 这份文件不依赖浏览器或 Electron：扩展 service worker、桌面软件和 Node
 * 测试都通过同一套归一化规则处理坐标、时间轴和任务状态，避免「桌面端能
 * 播放、扩展端却读不懂结果」这种跨进程问题。
 */
var BILI_COMPANION = (() => {
  const PROTOCOL = "video-digest-companion";
  const VERSION = 1;
  const HOST_NAME = "com.video_digest.companion";
  const TRACK_KINDS = Object.freeze(["ocr", "asr"]);
  const RECOGNITION_MODES = Object.freeze(["ocr", "asr", "both"]);
  const TASK_STATES = Object.freeze([
    "queued",
    "running",
    "paused",
    "completed",
    "canceled",
    "failed",
  ]);

  const ACTIONS = Object.freeze({
    STATUS: "status",
    OPEN: "open",
    LIST_MODELS: "listModels",
    DOWNLOAD_MODEL: "downloadModel",
    UNINSTALL_MODEL: "uninstallModel",
    START_TASK: "startTask",
    PAUSE_TASK: "pauseTask",
    RESUME_TASK: "resumeTask",
    CANCEL_TASK: "cancelTask",
    RETRY_TASK: "retryTask",
    GET_TRANSCRIPT: "getTranscript",
    LIST_TRANSCRIPTS: "listTranscripts",
    DELETE_TRANSCRIPT: "deleteTranscript",
    UPDATE_TRANSCRIPT: "updateTranscript",
    LIST_TASKS: "listTasks",
  });

  const EVENTS = Object.freeze({
    STATUS_CHANGED: "statusChanged",
    TASK_CHANGED: "taskChanged",
    TRANSCRIPT_READY: "transcriptReady",
  });

  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

  function numberOr(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  function createId(prefix = "request") {
    const uuid = globalThis.crypto?.randomUUID?.();
    if (uuid) return `${prefix}-${uuid}`;
    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }

  /**
   * 字幕框使用视频画面内的归一化坐标。宽高至少保留 1%，并在边界处收缩，
   * 这样桌面窗口换比例或视频换分辨率时不会出现框跑出画面的情况。
   */
  function normalizeRegion(input = {}) {
    const source = input && typeof input === "object" ? input : {};
    const width = clamp(numberOr(source.width, 0.92), 0.01, 1);
    const height = clamp(numberOr(source.height, 0.18), 0.01, 1);
    const x = clamp(numberOr(source.x, (1 - width) / 2), 0, 1 - width);
    const y = clamp(numberOr(source.y, 0.76), 0, 1 - height);
    return {
      x: Number(x.toFixed(6)),
      y: Number(y.toFixed(6)),
      width: Number(width.toFixed(6)),
      height: Number(height.toFixed(6)),
    };
  }

  function presetRegion(name) {
    const presets = {
      bottom: { x: 0.05, y: 0.76, width: 0.9, height: 0.18 },
      top: { x: 0.05, y: 0.06, width: 0.9, height: 0.18 },
      fullBottom: { x: 0, y: 0.68, width: 1, height: 0.32 },
      center: { x: 0.1, y: 0.4, width: 0.8, height: 0.2 },
    };
    return normalizeRegion(presets[name] || presets.bottom);
  }

  function normalizeSegment(input, index = 0, trackKind = "asr") {
    const source = input && typeof input === "object" ? input : {};
    const start = Math.max(0, numberOr(source.start ?? source.from, 0));
    const rawEnd = numberOr(source.end ?? source.to, start + numberOr(source.duration, 0));
    const end = Math.max(start + 0.01, rawEnd);
    const text = String(source.text ?? source.content ?? source.display ?? "").trim();
    if (!text) return null;
    const id = String(source.id || `${trackKind}-${index}-${Math.round(start * 1000)}`);
    const confidence = source.confidence == null
      ? undefined
      : clamp(numberOr(source.confidence, 0), 0, 1);
    return {
      id,
      start: Number(start.toFixed(3)),
      end: Number(end.toFixed(3)),
      text: text.slice(0, 20000),
      ...(confidence == null ? {} : { confidence: Number(confidence.toFixed(4)) }),
    };
  }

  function normalizeTrack(input, kind) {
    const source = input && typeof input === "object" ? input : {};
    const segments = (Array.isArray(source.segments) ? source.segments : [])
      .map((segment, index) => normalizeSegment(segment, index, kind))
      .filter(Boolean)
      .sort((left, right) => left.start - right.start || left.end - right.end);
    return {
      kind,
      language: String(source.language || source.lang || "").trim().slice(0, 32),
      languageLabel: String(source.languageLabel || source.langLabel || "").trim().slice(0, 100),
      model: String(source.model || "").trim().slice(0, 200),
      segments,
    };
  }

  function normalizeTracks(input) {
    const source = input && typeof input === "object" ? input : {};
    const result = {};
    for (const kind of TRACK_KINDS) {
      const value = Array.isArray(source) ? source.find((item) => item?.kind === kind) : source[kind];
      if (value) result[kind] = normalizeTrack(value, kind);
    }
    return result;
  }

  function normalizeSourceContext(input) {
    const source = input && typeof input === "object" ? input : {};
    const bvid = String(source.bvid || "").trim();
    const page = Math.max(1, Math.floor(numberOr(source.page, 1)));
    return {
      kind: String(source.kind || "local").trim().slice(0, 32) || "local",
      ...(bvid ? { bvid } : {}),
      ...(source.videoId ? { videoId: String(source.videoId).trim().slice(0, 64) } : {}),
      page,
      url: String(source.url || "").trim().slice(0, 2000),
      title: String(source.title || "").trim().slice(0, 500),
      owner: String(source.owner || "").trim().slice(0, 300),
    };
  }

  function normalizeTranscript(input, { now = Date.now() } = {}) {
    const source = input && typeof input === "object" ? input : {};
    const sourceId = String(source.sourceId || source.id || "").trim();
    if (!sourceId) throw new Error("本地识别结果缺少 sourceId。");
    const tracks = normalizeTracks(source.tracks || source);
    if (!Object.keys(tracks).some((kind) => tracks[kind].segments.length)) {
      throw new Error("本地识别结果没有有效字幕段。");
    }
    const title = String(source.title || source.fileName || "未命名媒体").trim().slice(0, 500);
    const duration = Math.max(
      0,
      numberOr(source.duration, Math.max(
        0,
        ...Object.values(tracks).flatMap((track) => track.segments.map((segment) => segment.end)),
      )),
    );
    const context = normalizeSourceContext(source.context);
    return {
      schemaVersion: VERSION,
      sourceId,
      title: title || "未命名媒体",
      fileName: String(source.fileName || title).trim().slice(0, 500),
      duration: Number(duration.toFixed(3)),
      source: String(source.source || "local").trim() || "local",
      mode: RECOGNITION_MODES.includes(source.mode) ? source.mode : "both",
      region: normalizeRegion(source.region),
      context,
      tracks,
      createdAt: numberOr(source.createdAt, now),
      updatedAt: numberOr(source.updatedAt, now),
      ...(source.taskId ? { taskId: String(source.taskId).slice(0, 200) } : {}),
    };
  }

  function normalizeTask(input = {}) {
    const source = input && typeof input === "object" ? input : {};
    const state = TASK_STATES.includes(source.state) ? source.state : "queued";
    const mode = RECOGNITION_MODES.includes(source.mode) ? source.mode : "both";
    const done = Math.max(0, numberOr(source.done, 0));
    const total = Math.max(done, numberOr(source.total, 0));
    return {
      id: String(source.id || source.taskId || "").trim(),
      state,
      mode,
      done,
      total,
      percent: total ? Math.round((done / total) * 100) : 0,
      phase: String(source.phase || "").trim().slice(0, 100),
      message: String(source.message || "").trim().slice(0, 500),
      error: String(source.error || "").trim().slice(0, 500),
      sourceId: String(source.sourceId || "").trim(),
      title: String(source.title || source.fileName || "").trim().slice(0, 500),
      fileName: String(source.fileName || source.title || "").trim().slice(0, 500),
      updatedAt: numberOr(source.updatedAt, Date.now()),
    };
  }

  function normalizeStatus(input = {}) {
    const source = input && typeof input === "object" ? input : {};
    const models = Array.isArray(source.models)
      ? source.models.map((model) => {
          const item = model && typeof model === "object" ? model : { id: model };
          return {
            id: String(item.id || "").trim(),
            label: String(item.label || item.id || "").trim().slice(0, 200),
            kind: TRACK_KINDS.includes(item.kind) ? item.kind : "asr",
            installed: Boolean(item.installed),
            downloading: Boolean(item.downloading),
            downloadable: item.downloadable !== false,
            sourceConfigured: Boolean(item.sourceConfigured),
            sizeBytes: Math.max(0, numberOr(item.sizeBytes, 0)),
          };
        }).filter((model) => model.id)
      : [];
    return {
      installed: Boolean(source.installed),
      running: Boolean(source.running),
      engineReady: Boolean(source.engineReady),
      version: String(source.version || "").trim().slice(0, 100),
      models,
      activeTask: source.activeTask ? normalizeTask(source.activeTask) : null,
      taskHistory: Array.isArray(source.taskHistory)
        ? source.taskHistory.map(normalizeTask).filter((task) => task.id)
        : [],
      message: String(source.message || "").trim().slice(0, 500),
    };
  }

  function createRequest(action, payload = {}, requestId = createId("request")) {
    return {
      protocol: PROTOCOL,
      version: VERSION,
      type: "request",
      requestId,
      action,
      payload: payload && typeof payload === "object" ? payload : {},
    };
  }

  function isProtocolMessage(input) {
    return Boolean(
      input &&
        typeof input === "object" &&
        input.protocol === PROTOCOL &&
        Number(input.version) === VERSION,
    );
  }

  function formatTimestamp(seconds, { millis = false } = {}) {
    const value = Math.max(0, Number(seconds) || 0);
    const whole = Math.floor(value);
    const hours = Math.floor(whole / 3600);
    const minutes = Math.floor((whole % 3600) / 60);
    const secs = whole % 60;
    const fraction = millis ? `.${String(Math.floor((value - whole) * 1000)).padStart(3, "0")}` : "";
    return `${hours ? `${String(hours).padStart(2, "0")}:` : ""}${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}${fraction}`;
  }

  function escapeAss(text) {
    return String(text || "")
      .replace(/\\/g, "\\\\")
      .replace(/\r?\n/g, "\\N")
      .replace(/[{}]/g, "");
  }

  function formatSrtTimestamp(seconds) {
    const value = Math.max(0, Number(seconds) || 0);
    const whole = Math.floor(value);
    const hours = Math.floor(whole / 3600);
    const minutes = Math.floor((whole % 3600) / 60);
    const secs = whole % 60;
    const millis = Math.floor((value - whole) * 1000);
    return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")},${String(millis).padStart(3, "0")}`;
  }

  function formatVttTimestamp(seconds) {
    return formatSrtTimestamp(seconds).replace(",", ".");
  }

  function serializeSubtitle(trackInput, format = "vtt", title = "") {
    const kind = trackInput?.kind || "asr";
    const track = normalizeTrack(trackInput, kind);
    const entries = track.segments;
    const target = String(format || "vtt").toLowerCase();
    if (!["srt", "vtt", "ass"].includes(target)) {
      throw new Error("只支持 SRT、ASS 和 VTT 格式。");
    }
    if (target === "vtt") {
      const lines = ["WEBVTT", title ? `NOTE ${title.replace(/[\r\n]/g, " ")}` : "", ""];
      entries.forEach((entry) => {
        lines.push(
          `${formatVttTimestamp(entry.start)} --> ${formatVttTimestamp(entry.end)}`,
          entry.text,
          "",
        );
      });
      return `${lines.join("\n").trimEnd()}\n`;
    }
    if (target === "srt") {
      const lines = [];
      entries.forEach((entry, index) => {
        lines.push(
          String(index + 1),
          `${formatSrtTimestamp(entry.start)} --> ${formatSrtTimestamp(entry.end)}`,
          entry.text,
          "",
        );
      });
      return lines.join("\n");
    }
    const ass = [
      "[Script Info]",
      `Title: ${String(title || "Video Digest").replace(/[\r\n]/g, " ")}`,
      "ScriptType: v4.00+",
      "WrapStyle: 0",
      "ScaledBorderAndShadow: yes",
      "",
      "[V4+ Styles]",
      "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
      "Style: Default,Arial,48,&H00FFFFFF,&H000000FF,&H00000000,&H64000000,0,0,0,0,100,100,0,0,1,2,0,2,30,30,30,1",
      "",
      "[Events]",
      "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ];
    for (const entry of entries) {
      const assTime = (seconds) => {
        const value = Math.max(0, Number(seconds) || 0);
        const hours = Math.floor(value / 3600);
        const minutes = Math.floor((value % 3600) / 60);
        const secs = Math.floor(value % 60);
        const centis = Math.floor((value - Math.floor(value)) * 100);
        return `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}.${String(centis).padStart(2, "0")}`;
      };
      ass.push(`Dialogue: 0,${assTime(entry.start)},${assTime(entry.end)},Default,,0,0,0,,${escapeAss(entry.text)}`);
    }
    return `${ass.join("\n")}\n`;
  }

  return {
    PROTOCOL,
    VERSION,
    HOST_NAME,
    TRACK_KINDS,
    RECOGNITION_MODES,
    TASK_STATES,
    ACTIONS,
    EVENTS,
    createId,
    normalizeRegion,
    presetRegion,
    normalizeSegment,
    normalizeTrack,
    normalizeTracks,
    normalizeTranscript,
    normalizeTask,
    normalizeStatus,
    normalizeSourceContext,
    createRequest,
    isProtocolMessage,
    formatTimestamp,
    serializeSubtitle,
  };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = BILI_COMPANION;
}
