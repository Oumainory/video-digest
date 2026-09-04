/**
 * Bilibili Digest — service worker（MV3）：
 * 消息中转、字幕获取（WBI 签名）、LLM 调用、侧边栏按 tab 启用。
 */

importScripts(
  "settings.js",
  "lib/wbi.js",
  "lib/bili-api.js",
  "lib/youtube-api.js",
  "lib/transcript.js",
  "lib/ai.js",
  "lib/ai-provider.js",
  "lib/concurrency.js",
  "lib/task-manager.js",
  "lib/companion-protocol.js",
  "lib/companion-bridge.js",
  // 依赖顺序是硬约束：模块顶层的 typeof 守卫在 importScripts 里立即求值，
  // 被依赖的文件必须先加载，否则 service worker 直接注册失败。
  // 各文件的依赖以其 require 声明为准，manifest.test.js 会校验顺序。
  "lib/idb.js",
  "lib/local-transcript-store.js",
  "lib/learning-store.js",
  "lib/cache.js",
  "lib/note-db.js",
  "lib/ai-transport.js",
  "lib/notes-service.js",
  "lib/transcript-service.js",
  "lib/analysis-service.js",
  "lib/qa-retrieval.js",
  "lib/qa-citations.js",
  "lib/qa-service.js",
);

const DEBUG = false;
const debugLog = (...args) => {
  if (DEBUG) console.log(...args);
};

const companionProtocol = typeof BILI_COMPANION === "undefined"
  ? {
      ACTIONS: {
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
      },
      EVENTS: {},
      HOST_NAME: "com.video_digest.companion",
      normalizeTask: (task) => task,
      normalizeStatus: (status) => status,
    }
  : BILI_COMPANION;

// 本地 OCR/ASR 只通过 Native Messaging 连接桌面伴生软件。扩展不暴露
// localhost、端口或运行时细节；桌面软件安装时注册同名 host 即可被发现。
// 浏览器运行时 importScripts 会提供真实桥接实现。保留一个只报错的降级
// 对象，避免共享模块加载失败时连 B 站字幕/笔记入口也无法启动。
const companionBridge = typeof BILI_COMPANION_BRIDGE === "undefined"
  ? {
      request: async () => {
        const error = new Error("没有检测到桌面识别软件。");
        error.code = "COMPANION_NOT_INSTALLED";
        throw error;
      },
      close() {},
    }
  : BILI_COMPANION_BRIDGE.createCompanionBridge({
      hostName: companionProtocol.HOST_NAME,
      connectNative: (hostName) => chrome.runtime.connectNative(hostName),
      onEvent: handleCompanionEvent,
    });

// AI 请求的传输与策略层在 lib/ai-transport.js；这里注入环境依赖后
// 解构成同名函数，业务代码的调用方式保持不变。
const {
  requestAiCompletion,
  aiErrorResponse,
  throwIfTaskCanceled,
  taskCanceledError,
} = BILI_AI_TRANSPORT.createAiTransport({
  getSettings,
  ensureHostPermission,
  log: debugLog,
  fetch: globalThis.fetch,
});

const AI_TASK_KINDS = new Set(["analysis", "polish", "translate", "note-refine", "qa"]);
const aiTasks = BILI_TASKS.createTaskManager({
  onChange(task) {
    chrome.runtime.sendMessage({ action: "aiTaskChanged", task }).catch(() => {});
  },
});

function aiTaskKey(message) {
  if (message.kind === "note-refine") return `note-refine:${message.noteId || ""}`;
  const page = Number(message.page) > 0 ? Math.floor(Number(message.page)) : 1;
  return `${message.kind}:${message.bvid || ""}:p${page}`;
}

// 笔记业务（保存去重、后台润色、AI 候选、备份）在 lib/notes-service.js。
// 字幕管线在 lib/transcript-service.js；缓存读改写助手供概览 / 顺句 / 翻译共用。
const {
  fetchTranscript: handleFetchTranscript,
  ensureTranscript,
  updateCache,
  persistable,
} = BILI_TRANSCRIPT_SERVICE.createTranscriptService({
  cache: BILI_CACHE,
  dataReady: learningDataReady,
  learningRepository,
  getSettings,
  logDebug: debugLog,
  logError: (...args) => console.error(...args),
});

// 概览生成管线在 lib/analysis-service.js。
const {
  analyzeTranscript: handleAnalyzeTranscript,
  retryFailedAnalysis: handleRetryFailedAnalysis,
} = BILI_ANALYSIS_SERVICE.createAnalysisService({
  cache: BILI_CACHE,
  dataReady: learningDataReady,
  learningRepository,
  getSettings,
  ensureTranscript,
  updateCache,
  persistable,
  loadPromptSection,
  requestAiCompletion,
  aiErrorResponse,
  broadcast: (message) => {
    chrome.runtime.sendMessage(message).catch(() => {});
  },
  onTaskProgress: (taskId, patch) => aiTasks.progress(taskId, patch),
  logDebug: debugLog,
  logError: (...args) => console.error(...args),
});

// 问答历史仓储（bili-digest 库的 qa 仓库，见 lib/idb.js）。
let qaRepo = null;
function qaRepository() {
  if (!qaRepo) {
    qaRepo = BILI_QA_SERVICE.createQaRepository({
      driver: BILI_IDB.createObjectStoreDriver({
        storeName: "qa",
        indexedDB: globalThis.indexedDB,
      }),
    });
  }
  return qaRepo;
}

// 视频问答在 lib/qa-service.js。
const qaService = BILI_QA_SERVICE.createQaService({
  cache: BILI_CACHE,
  dataReady: learningDataReady,
  ensureTranscript,
  learningRepository,
  getSettings,
  repository: qaRepository,
  loadPromptSection,
  requestAiCompletion,
  aiErrorResponse,
  onTaskProgress: (taskId, patch) => aiTasks.progress(taskId, patch),
  logError: (...args) => console.error(...args),
});

const notesService = BILI_NOTES_SERVICE.createNotesService({
  repositories: { notes: notesRepository, learning: learningRepository },
  dataReady: learningDataReady,
  ensureTranscript,
  loadPromptSection,
  requestAiCompletion,
  settingsValid: async () => BILI_SETTINGS.validate(await getSettings()).ok,
  broadcast: (message) => {
    chrome.runtime.sendMessage(message).catch(() => {});
  },
  onTaskProgress: (taskId, patch) => aiTasks.progress(taskId, patch),
  logWarn: (...args) => console.warn(...args),
});

function startAiTask(message) {
  if (!message.taskId || !AI_TASK_KINDS.has(message.kind)) {
    return {
      success: false,
      error: "INVALID_TASK",
      message: "任务参数不完整。",
    };
  }
  return aiTasks.start({
    id: String(message.taskId),
    kind: message.kind,
    key: aiTaskKey(message),
  });
}

async function runManagedAiOperation(taskId, operation, { autoFinish = false } = {}) {
  const signal = taskId ? aiTasks.signal(taskId) : null;
  if (taskId && !signal) {
    return { success: false, error: "TASK_NOT_FOUND", message: "任务已经结束。" };
  }

  let result;
  try {
    result = await operation(signal);
  } catch (error) {
    result = aiErrorResponse(error);
  } finally {
    if (taskId && autoFinish) {
      const canceled = signal?.aborted;
      aiTasks.finish(taskId, {
        state: canceled ? "canceled" : result?.success ? "completed" : "failed",
        message: canceled ? "已取消" : result?.success ? "已完成" : "生成失败",
      });
    }
  }
  return result;
}

/**
 * MV3 只为「正在处理的事件」保活 service worker，顶层发起的异步调用不算数：
 * 求值一结束浏览器就有权回收 worker，在途的扩展 API 调用会被判死刑，
 * Chromium 回一句 `No SW`。所以这个文件的顶层不做任何异步工作，
 * 需要落地的初始化挂到真实事件上，需要数据的地方惰性触发。
 */

// 内容脚本运行在 B 站页面上下文，不应读到密钥或缓存。
function restrictStorageAccess() {
  chrome.storage.local
    .setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" })
    .catch((error) =>
      console.warn("[Bilibili Digest] 无法限制存储访问级别：", error),
    );
}

const learningStorage = chrome.storage.local;

// 笔记与概览快照的正牌后端是 IndexedDB（见 lib/note-db.js / lib/learning-store.js），
// 连接整个 worker 生命周期复用。indexedDB 在这里显式传入而不是让驱动自己摸全局：
// 模块文件在测试里是跨 realm 加载的，宿主的 globalThis 上没有它。
let notesRepo = null;
function notesRepository() {
  if (!notesRepo) {
    notesRepo = BILI_NOTE_DB.createNotesRepository({
      driver: BILI_NOTE_DB.createIndexedDbDriver({
        indexedDB: globalThis.indexedDB,
      }),
    });
  }
  return notesRepo;
}

let learningRepo = null;
function learningRepository() {
  if (!learningRepo) {
    learningRepo = BILI_LEARNING_STORE.createLearningRepository({
      driver: BILI_IDB.createObjectStoreDriver({
        storeName: "learning",
        indexedDB: globalThis.indexedDB,
      }),
    });
  }
  return learningRepo;
}

let localTranscriptRepo = null;
function localTranscriptRepository() {
  if (!localTranscriptRepo) {
    localTranscriptRepo = BILI_LOCAL_TRANSCRIPT_STORE.createLocalTranscriptRepository({
      driver: BILI_IDB.createObjectStoreDriver({
        storeName: "local-transcripts",
        indexedDB: globalThis.indexedDB,
      }),
    });
  }
  return localTranscriptRepo;
}

function companionErrorResponse(error) {
  const code = String(error?.code || "COMPANION_REQUEST_FAILED");
  const messages = {
    COMPANION_NOT_INSTALLED: "没有检测到桌面识别软件，请先安装官方伴生程序。",
    COMPANION_UNAVAILABLE: "桌面识别软件连接不可用，请重新打开软件。",
    COMPANION_DISCONNECTED: "桌面识别软件已退出，请重新打开软件。",
    COMPANION_TIMEOUT: "桌面软件响应超时，请确认软件仍在运行。",
  };
  return {
    success: false,
    error: code,
    message: messages[code] || String(error?.message || "桌面软件请求失败。"),
  };
}

async function handleCompanionEvent(event, payload = {}) {
  if (event === companionProtocol.EVENTS.TRANSCRIPT_READY) {
    try {
      const result = await localTranscriptRepository().save(
        payload.result || payload.transcript || payload,
      );
      chrome.runtime
        .sendMessage({ action: "localTranscriptReady", result })
        .catch(() => {});
    } catch (error) {
      chrome.runtime
        .sendMessage({
          action: "localTranscriptError",
          error: error.message || "本地识别结果无效。",
        })
        .catch(() => {});
    }
    return;
  }

  if (event === companionProtocol.EVENTS.TASK_CHANGED) {
    chrome.runtime
      .sendMessage({
        action: "companionTaskChanged",
        task: companionProtocol.normalizeTask(payload.task || payload),
      })
      .catch(() => {});
    return;
  }

  if (event === companionProtocol.EVENTS.STATUS_CHANGED) {
    chrome.runtime
      .sendMessage({
        action: "companionStatusChanged",
        status: companionProtocol.normalizeStatus(payload.status || payload),
      })
      .catch(() => {});
  }
}

async function forwardCompanionRequest(action, payload, sendResponse) {
  try {
    const result = await companionBridge.request(action, payload);
    sendResponse({
      success: true,
      ...(result && typeof result === "object" ? result : { value: result }),
    });
  } catch (error) {
    sendResponse(companionErrorResponse(error));
  }
}

// 旧版本把笔记数组写在 storage.local，再往前连概览都挤在字幕缓存里。所有
// 读写都等这条迁移链完成：v2 数据迁移 → 笔记 → 字幕缓存 → 概览快照，
// 前一步是后一步的数据来源（v2 提升的概览要等最后一步统一搬走）。
// 整个 worker 生命周期只跑一次，但失败时要把记忆清掉：否则一次偶发失败会让
// 这条 worker 上的后续操作全部停在降级状态，直到浏览器下次回收它为止。
let learningMigration = null;
function learningDataReady() {
  if (!learningMigration) {
    learningMigration = (async () => {
      await BILI_LEARNING_STORE.ensureMigrated({
        storage: learningStorage,
      });
      await BILI_NOTE_DB.ensureNotesInIdb({
        storage: learningStorage,
        repository: notesRepository(),
      });
      await BILI_CACHE.ensureCacheInIdb({
        storage: learningStorage,
      });
      await BILI_LEARNING_STORE.ensureLearningInIdb({
        storage: learningStorage,
        repository: learningRepository(),
      });
    })().catch((error) => {
      console.error("[Bilibili Digest] 学习资料迁移失败：", error);
      learningMigration = null;
      // 迁移失败也先让旧笔记可读；后续写入会给出明确错误，不能因为升级元数据
      // 没写进去就把用户原有内容整个挡住。
      return { migrated: false, error };
    });
  }
  return learningMigration;
}

async function getSettings() {
  const stored = await chrome.storage.local.get(BILI_SETTINGS.STORAGE_KEY);
  return BILI_SETTINGS.normalize(stored[BILI_SETTINGS.STORAGE_KEY]);
}

// ============================================================
// 侧边栏
// ============================================================

/**
 * 每个浏览器窗口只允许一个明确打开过 Digest 的标签页显示侧边栏。
 * Chrome 的默认侧边栏是窗口级的；仅按 URL 把所有视频页设为 enabled，
 * 会让 A 窗口打开的面板跟到从未打开过它的 B 窗口。这里把 owner 记在
 * storage.session，service worker 被回收后也能恢复窗口各自的状态。
 */
const PANEL_OWNERS_KEY = "video_digest_panel_owners";
const panelOwners = new Map();
let panelOwnersLoaded = null;

async function loadPanelOwners() {
  if (panelOwnersLoaded) return panelOwnersLoaded;
  panelOwnersLoaded = (async () => {
    const storage = chrome.storage?.session;
    if (!storage?.get) return;
    const stored = await storage.get(PANEL_OWNERS_KEY).catch(() => ({}));
    const owners = stored?.[PANEL_OWNERS_KEY];
    if (!owners || typeof owners !== "object") return;
    for (const [windowId, tabId] of Object.entries(owners)) {
      const parsedWindowId = Number(windowId);
      if (Number.isInteger(parsedWindowId) && Number.isInteger(tabId)) {
        panelOwners.set(parsedWindowId, tabId);
      }
    }
  })();
  return panelOwnersLoaded;
}

function persistPanelOwners() {
  const storage = chrome.storage?.session;
  if (!storage?.set) return Promise.resolve();
  return storage.set({
    [PANEL_OWNERS_KEY]: Object.fromEntries(panelOwners),
  }).catch(() => {});
}

async function rememberPanelOwner(tab) {
  if (!Number.isInteger(tab?.windowId) || !Number.isInteger(tab?.id)) return;
  await loadPanelOwners();
  panelOwners.set(tab.windowId, tab.id);
  await persistPanelOwners();
}

// 图标点击由 chrome.action.onClicked 直接处理。关闭浏览器的自动全局打开，
// 否则它会先于 tabId 绑定把同一个面板带到其它窗口。
function enableActionClickToOpen() {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: false })
    .catch((error) =>
      console.warn("[Bilibili Digest] 无法设置侧边栏点击行为：", error),
    );
}

function isDigestVideoUrl(url) {
  const value = String(url || "");
  return Boolean(
    /https:\/\/(?:www\.)?bilibili\.com\/(?:video|list)\//i.test(value)
    || VIDEO_DIGEST_YOUTUBE.parseVideoId(value),
  );
}

function setTabPanelEnabled(tabId, url, enabled = true) {
  if (!Number.isInteger(tabId) || !chrome.sidePanel?.setOptions) return Promise.resolve();
  return chrome.sidePanel.setOptions({
    tabId,
    path: "sidepanel.html",
    enabled: Boolean(enabled && isDigestVideoUrl(url)),
  }).catch((error) => {
    console.warn("[Bilibili Digest] 无法更新标签页侧边栏状态：", error);
  });
}

async function configureWindowPanels(ownerTab) {
  if (!Number.isInteger(ownerTab?.windowId) || !Number.isInteger(ownerTab?.id)) return;
  const tabs = await chrome.tabs.query({ windowId: ownerTab.windowId });
  await Promise.all(
    tabs.map((tab) => setTabPanelEnabled(
      tab.id,
      tab.url || tab.pendingUrl,
      tab.id === ownerTab.id,
    )),
  );
}

async function initializeTabPanel(tab) {
  if (!Number.isInteger(tab?.id) || !Number.isInteger(tab?.windowId)) return;
  await loadPanelOwners();
  return setTabPanelEnabled(
    tab.id,
    tab.url || tab.pendingUrl,
    panelOwners.get(tab.windowId) === tab.id,
  );
}

async function syncAllTabPanels() {
  if (!chrome.tabs?.query) return;
  try {
    const tabs = await chrome.tabs.query({});
    await Promise.all(tabs.map((tab) => initializeTabPanel(tab)));
  } catch (error) {
    console.warn("[video-digest] 无法初始化标签页侧边栏：", error);
  }
}

// 新标签页在真正切过去前先写好 tab-specific 状态；如果等 onActivated
// 以后才 disabled，Edge 会把原标签页的面板当成“已关闭”而不是暂时隐藏。
if (chrome.tabs?.onCreated?.addListener) {
  chrome.tabs.onCreated.addListener((tab) => {
    void initializeTabPanel(tab);
  });
}

if (chrome.tabs?.onActivated?.addListener) {
  chrome.tabs.onActivated.addListener(async ({ tabId }) => {
    try {
      const tab = await chrome.tabs.get(tabId);
      await initializeTabPanel(tab);
    } catch (error) {
      console.warn("[Bilibili Digest] 无法同步活动标签页侧边栏：", error);
    }
  });
}

if (chrome.tabs?.onUpdated?.addListener) {
  chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.url || changeInfo.status === "complete") {
      void initializeTabPanel({
        ...tab,
        id: tabId,
        url: changeInfo.url || tab?.url,
      });
    }
  });
}

// 切换浏览器窗口不会触发 tabs.onActivated；必须单独同步新聚焦窗口，
// 否则它会沿用上一个窗口的全局面板。
if (chrome.windows?.onFocusChanged?.addListener) {
  chrome.windows.onFocusChanged.addListener(async (windowId) => {
    if (!Number.isInteger(windowId) || windowId === chrome.windows.WINDOW_ID_NONE) return;
    try {
      const [tab] = await chrome.tabs.query({ active: true, windowId });
      await initializeTabPanel(tab);
    } catch (error) {
      console.warn("[Bilibili Digest] 无法同步窗口侧边栏状态：", error);
    }
  });
}

if (chrome.tabs?.onRemoved?.addListener) {
  chrome.tabs.onRemoved.addListener((tabId, { windowId } = {}) => {
    if (panelOwners.get(windowId) !== tabId) return;
    panelOwners.delete(windowId);
    void persistPanelOwners();
  });
}

if (chrome.windows?.onRemoved?.addListener) {
  chrome.windows.onRemoved.addListener((windowId) => {
    if (!panelOwners.delete(windowId)) return;
    void persistPanelOwners();
  });
}

// 这两项都是持久化设置，装好/升级/浏览器启动时各设一次即可，不必每次
// worker 醒来都重设——那正是会撞上 `No SW` 的顶层异步。
function initializeOnce() {
  restrictStorageAccess();
  enableActionClickToOpen();
  void syncAllTabPanels();
}

chrome.runtime.onStartup.addListener(initializeOnce);

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  initializeOnce();
  if (reason === "install") chrome.runtime.openOptionsPage();
  // 升级正是数据迁移该发生的时刻，而且这里是真事件，有 keepalive 兜着。
  // 万一仍被打断，各读写路径上的 learningDataReady() 会再补一次。
  await learningDataReady();
});

/**
 * 播放页上那个注入的 Digest 按钮走这条路。手势能否从内容脚本的消息传递到这里，
 * Chrome 认，Edge 不一定认。被拒绝时如实回话，让页面上的按钮改口引导用户去点
 * 工具栏图标——那条路由浏览器自己处理，一定有效。
 */
async function handleOpenSidePanel(tab) {
  if (!Number.isInteger(tab?.id) || !isDigestVideoUrl(tab?.url)) {
    return { success: false };
  }

  const ownerSaved = rememberPanelOwner(tab);
  const windowConfigured = configureWindowPanels(tab);
  // 两个调用都在用户手势的同步调用栈里发起。先 await setOptions 会让部分
  // Chromium 版本认为手势已经结束，从而拒绝 open()。
  const enabled = setTabPanelEnabled(tab.id, tab.url, true);
  const opened = chrome.sidePanel.open({ tabId: tab.id });
  try {
    await Promise.all([ownerSaved, windowConfigured, enabled, opened]);
  } catch (error) {
    console.warn("[Bilibili Digest] 打开侧边栏被拒绝：", error);
    return { success: false, needsToolbarClick: true };
  }

  // 侧边栏可能本来就开着而且停在别的视频上，广播一次让它跟过来。
  // 刚打开的那种情形不必担心广播丢失，面板自己启动时就会同步当前标签页。
  chrome.runtime
    .sendMessage({ action: "startDigestFromButton" })
    .catch(() => {});
  return { success: true };
}

if (chrome.action?.onClicked?.addListener) {
  chrome.action.onClicked.addListener((tab) => {
    void handleOpenSidePanel(tab);
  });
}

// ============================================================
// 消息路由
// ============================================================

// YouTube 只读页面本身已经提供的官方 caption track。内容脚本负责从页面
// 取 player response，service worker 负责下载正文并复用现有的分段逻辑。
async function handleYoutubeTranscript(message = {}) {
  const youtubeId = VIDEO_DIGEST_YOUTUBE.parseVideoId(message.videoId || message.url);
  if (!youtubeId) {
    return { success: false, error: "INVALID_YOUTUBE_ID", message: "没有识别到 YouTube 视频。" };
  }
  const sourceId = `youtube:${youtubeId}`;
  const page = 1;
  const capturedUrls = [
    ...(Array.isArray(message.captionTrackUrls) ? message.captionTrackUrls : []),
    message.captionTrackUrl,
  ].filter(Boolean);
  const capturedBodies = Array.isArray(message.captionBodies) ? message.captionBodies : [];
  const hasCurrentPageEvidence = Boolean(
    (message.playerResponse && typeof message.playerResponse === "object")
    || capturedUrls.length
    || capturedBodies.length
    || message.pageCaptionBody,
  );
  if (!message.forceRefresh) {
    const cached = await BILI_CACHE.load(sourceId, { page });
    if (cached?.transcript?.length && !hasCurrentPageEvidence) {
      return { ...cached, success: true, fromCache: true };
    }
  }

  const capturedTracks = capturedUrls
    .map((url) => VIDEO_DIGEST_YOUTUBE.captionTrackFromUrl(url, youtubeId))
    .filter(Boolean)
    .filter((track, index, list) => list.findIndex((item) => item.url === track.url) === index);
  const capturedTrack = capturedTracks.length
    ? capturedTracks[capturedTracks.length - 1]
    : null;
  if ((!message.playerResponse || typeof message.playerResponse !== "object") && !capturedTracks.length) {
    return {
      success: false,
      error: "YOUTUBE_PLAYER_DATA_UNAVAILABLE",
      message: "YouTube 播放器数据还没准备好。请刷新视频页面后重试。",
    };
  }

  const tracks = VIDEO_DIGEST_YOUTUBE.normalizeCaptionTracks(
    message.playerResponse,
    youtubeId,
  );
  if (!tracks.length && capturedTracks.length) tracks.push(...capturedTracks);
  if (!tracks.length) {
    return {
      success: false,
      error: "NO_SUBTITLE",
      message: "这个 YouTube 视频没有可用的官方字幕。",
    };
  }
  const settings = await getSettings();
  const preference = Array.isArray(message.languagePreference) && message.languagePreference.length
    ? message.languagePreference
    : settings.subtitleLangPreference;
  const preferredTrack = VIDEO_DIGEST_YOUTUBE.pickCaptionTrack(tracks, preference);
  // playerResponse 里的 baseUrl 可能缺少当前播放会话动态附加的参数，表现为
  // HTTP 200 但正文为空。页面播放器实际请求过的 timedtext URL 已经过同视频
  // 校验；与首选语言匹配时优先使用活动轨，静态轨道只负责语言选择和兜底。
  const preferredLanguage = preferredTrack?.effectiveLang || preferredTrack?.lang;
  const activePreferred = [...capturedTracks].reverse().find((track) => {
    const language = track.effectiveLang || track.lang;
    return language === preferredLanguage
      || language.startsWith(`${preferredLanguage}-`)
      || preferredLanguage?.startsWith(`${language}-`);
  });
  const primaryTrack = activePreferred || capturedTrack || preferredTrack;
  const trackCandidates = [primaryTrack];
  if (preferredTrack?.url !== primaryTrack?.url) trackCandidates.push(preferredTrack);
  const sameCaptionLanguage = (left, right) => {
    const leftLanguage = String(left?.effectiveLang || left?.lang || "");
    const rightLanguage = String(right?.effectiveLang || right?.lang || "");
    return Boolean(leftLanguage && rightLanguage) && (
      leftLanguage === rightLanguage
      || leftLanguage.startsWith(`${rightLanguage}-`)
      || rightLanguage.startsWith(`${leftLanguage}-`)
    );
  };
  const capturedBodyForTrack = (candidate) => {
    if (!candidate) return null;
    return [...capturedBodies].reverse().find((item) => {
      if (!item?.body) return false;
      if (item.url === candidate.url) return true;
      const capturedTrack = VIDEO_DIGEST_YOUTUBE.captionTrackFromUrl(item.url, youtubeId);
      return sameCaptionLanguage(capturedTrack, candidate);
    }) || null;
  };
  const primaryBody = capturedBodyForTrack(primaryTrack)
    || (preferredTrack?.url !== primaryTrack?.url ? capturedBodyForTrack(preferredTrack) : null);
  let track = primaryTrack;
  try {
    const pageTrack = VIDEO_DIGEST_YOUTUBE.captionTrackFromUrl(
      message.pageCaptionTrackUrl,
      youtubeId,
    );
    const pageCandidate = pageTrack && trackCandidates.find(
      (candidate) => pageTrack.lang === candidate.lang && pageTrack.url === candidate.url,
    );
    let entries = [];
    let receivedResponse = false;
    let fetchError = null;
    if (primaryBody?.body) {
      track = primaryTrack;
      receivedResponse = true;
      entries = VIDEO_DIGEST_YOUTUBE.parseCaptionTrackContent(
        primaryBody.body,
        primaryBody.contentType,
      );
    }
    if (!entries.length && pageCandidate && typeof message.pageCaptionBody === "string") {
      track = pageCandidate;
      receivedResponse = true;
      entries = VIDEO_DIGEST_YOUTUBE.parseCaptionTrackContent(
        message.pageCaptionBody,
        message.pageCaptionContentType,
      );
    }
    for (const candidate of trackCandidates) {
      if (entries.length || candidate.url === pageCandidate?.url) continue;
      try {
        const downloaded = await VIDEO_DIGEST_YOUTUBE.fetchCaptionTrackContent(candidate.url);
        receivedResponse = true;
        if (downloaded.length) {
          entries = downloaded;
          track = candidate;
        }
      } catch (error) {
        fetchError ||= error;
      }
    }
    if (!entries.length) {
      return {
        success: false,
        error: receivedResponse
          ? "EMPTY_TRANSCRIPT"
          : (fetchError?.code || "TRANSCRIPT_FETCH_FAILED"),
        message: receivedResponse
          ? "YouTube 字幕文件是空的。"
          : (fetchError?.message || "YouTube 字幕获取失败。"),
        // 后台请求可能拿不到用户所在地区/登录态下的字幕。只把已经校验并
        // 捕获到的播放器会话 URL 交回当前页面重试一次。
        needsPageCaptionFetch: !message.pageCaptionFetchAttempted,
        pageCaptionTrackUrl: primaryTrack.url,
      };
    }
    const videoInfo = VIDEO_DIGEST_YOUTUBE.normalizeVideoInfo(
      message.playerResponse,
      youtubeId,
      message.sourceUrl,
      message.pageInfo,
    );
    const texts = BILI_TRANSCRIPT.buildTranscriptTexts(entries);
    const result = {
      videoInfo,
      transcript: entries,
      segments: BILI_TRANSCRIPT.groupTranscriptEntries(entries),
      transcriptText: texts.plain,
      transcriptTextTimestamped: texts.timestamped,
      language: track.lang,
      languageLabel: track.langLabel,
      isAiSubtitle: track.isAi,
      availableTracks: tracks.map(({ lang, langLabel, isAi }) => ({ lang, langLabel, isAi })),
    };
    await BILI_CACHE.save(sourceId, result, { page });
    return { ...result, success: true, fromCache: false };
  } catch (error) {
    return {
      success: false,
      error: error.code || "TRANSCRIPT_FETCH_FAILED",
      message: error.message || "YouTube 字幕获取失败。",
      needsPageCaptionFetch: !message.pageCaptionFetchAttempted,
      pageCaptionTrackUrl: primaryTrack.url,
    };
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.action === "startAiTask") {
    sendResponse(startAiTask(message));
    return false;
  }

  if (message?.action === "getAiTasks") {
    sendResponse({ success: true, tasks: aiTasks.list() });
    return false;
  }

  if (message?.action === "cancelAiTask") {
    sendResponse(aiTasks.cancel(message.taskId));
    return false;
  }

  if (message?.action === "finishAiTask") {
    const task = aiTasks.finish(message.taskId, {
      state: message.state,
      message: message.message,
    });
    sendResponse({ success: Boolean(task), task });
    return false;
  }

  if (message?.action === "updateAiTaskProgress") {
    const task = aiTasks.progress(message.taskId, {
      done: message.done,
      total: message.total,
      phase: message.phase,
      message: message.message,
    });
    sendResponse({ success: Boolean(task), task });
    return false;
  }

  if (message?.action === "fetchTranscript") {
    handleFetchTranscript(message.bvid, {
      page: message.page,
      forceRefresh: message.forceRefresh,
    })
      .then(sendResponse)
      .catch((error) => sendResponse({ success: false, error: error.message }));
    return true; // 保持消息通道开启以异步回复
  }

  if (message?.action === "fetchYoutubeTranscript") {
    handleYoutubeTranscript(message)
      .then(sendResponse)
      .catch((error) => sendResponse({ success: false, error: error.message }));
    return true;
  }

  if (message?.action === "checkConfig") {
    getSettings()
      .then((settings) => {
        const check = BILI_SETTINGS.validate(settings);
        sendResponse({ ready: check.ok, errors: check.errors });
      })
      .catch((error) => sendResponse({ error: error.message }));
    return true;
  }

  if (message?.action === "openOptions") {
    chrome.runtime.openOptionsPage();
    sendResponse({ success: true });
    return false;
  }

  if (message?.action === "openSidePanel") {
    handleOpenSidePanel(sender.tab)
      .then(sendResponse)
      .catch(() => sendResponse({ success: false, needsToolbarClick: true }));
    return true;
  }

  // 桌面伴生软件相关消息都通过统一桥接层转发。payload 只包含任务上下文，
  // 不把文件内容塞进扩展消息，视频选择和处理始终发生在桌面端。
  const companionActions = {
    getCompanionStatus: companionProtocol.ACTIONS.STATUS,
    openCompanion: companionProtocol.ACTIONS.OPEN,
    listCompanionModels: companionProtocol.ACTIONS.LIST_MODELS,
    downloadCompanionModel: companionProtocol.ACTIONS.DOWNLOAD_MODEL,
    uninstallCompanionModel: companionProtocol.ACTIONS.UNINSTALL_MODEL,
    startLocalTask: companionProtocol.ACTIONS.START_TASK,
    pauseLocalTask: companionProtocol.ACTIONS.PAUSE_TASK,
    resumeLocalTask: companionProtocol.ACTIONS.RESUME_TASK,
    cancelLocalTask: companionProtocol.ACTIONS.CANCEL_TASK,
    retryLocalTask: companionProtocol.ACTIONS.RETRY_TASK,
  };
  if (message?.action && companionActions[message.action]) {
    const payload = message.payload && typeof message.payload === "object"
      ? message.payload
      : { ...message };
    delete payload.action;
    forwardCompanionRequest(companionActions[message.action], payload, sendResponse);
    return true;
  }

  if (message?.action === "getLocalTranscript") {
    localTranscriptRepository()
      .find(message.sourceId)
      .then((result) => sendResponse({ success: true, result }))
      .catch((error) => sendResponse({ success: false, error: error.message }));
    return true;
  }

  if (message?.action === "listLocalTranscripts") {
    localTranscriptRepository()
      .all()
      .then((results) => sendResponse({ success: true, results }))
      .catch((error) => sendResponse({ success: false, error: error.message }));
    return true;
  }

  if (message?.action === "deleteLocalTranscript") {
    localTranscriptRepository()
      .remove(message.sourceId)
      .then(() => sendResponse({ success: true }))
      .catch((error) => sendResponse({ success: false, error: error.message }));
    return true;
  }

  if (message?.action === "analyzeTranscript") {
    runManagedAiOperation(
      message.taskId,
      (signal) => handleAnalyzeTranscript(message.bvid, {
        page: message.page,
        forceRefresh: message.forceRefresh,
        signal,
        taskId: message.taskId,
      }),
      { autoFinish: true },
    )
      .then(sendResponse)
      .catch((error) => sendResponse({ success: false, error: error.message }));
    return true;
  }

  if (message?.action === "retryFailedAnalysis") {
    runManagedAiOperation(
      message.taskId,
      (signal) => handleRetryFailedAnalysis(message.bvid, {
        page: message.page,
        signal,
        taskId: message.taskId,
      }),
      { autoFinish: true },
    )
      .then(sendResponse)
      .catch((error) => sendResponse({ success: false, error: error.message }));
    return true;
  }

  if (message?.action === "polishSegments") {
    runManagedAiOperation(message.taskId, (signal) =>
      handlePolishSegments(message.bvid, {
        page: message.page,
        segmentIds: message.segmentIds,
        signal,
      }),
    )
      .then(sendResponse)
      .catch((error) => sendResponse({ success: false, error: error.message }));
    return true;
  }

  if (message?.action === "translateSegments") {
    runManagedAiOperation(message.taskId, (signal) =>
      handleTranslateSegments(message.bvid, {
        page: message.page,
        segmentIds: message.segmentIds,
        signal,
      }),
    )
      .then(sendResponse)
      .catch((error) => sendResponse({ success: false, error: error.message }));
    return true;
  }

  if (message?.action === "explainSelection") {
    handleExplainSelection(
      message.selectedText,
      message.transcriptContext,
      message.videoTitle,
    )
      .then(sendResponse)
      .catch((error) => sendResponse({ success: false, error: error.message }));
    return true;
  }

  if (message?.action === "saveNote") {
    notesService
      .saveNote(message)
      .then(sendResponse)
      .catch((error) => sendResponse(notesService.noteWriteErrorResponse(error)));
    return true;
  }

  if (message?.action === "getNotes") {
    notesService
      .getNotes(message.bvid, message.page)
      .then(sendResponse)
      .catch((error) => sendResponse({ success: false, error: error.message }));
    return true;
  }

  if (message?.action === "deleteNote") {
    notesService
      .deleteNote(message.noteId)
      .then(sendResponse)
      .catch((error) => sendResponse(notesService.noteWriteErrorResponse(error)));
    return true;
  }

  if (message?.action === "updateNote") {
    notesService
      .updateNote(message.noteId, message.text)
      .then(sendResponse)
      .catch((error) => sendResponse(notesService.noteWriteErrorResponse(error)));
    return true;
  }

  if (message?.action === "generateNoteDraft") {
    runManagedAiOperation(
      message.taskId,
      (signal) =>
        notesService.generateNoteDraft(message.noteId, {
          signal,
          taskId: message.taskId,
        }),
      { autoFinish: true },
    )
      .then(sendResponse)
      .catch((error) => sendResponse(aiErrorResponse(error)));
    return true;
  }

  if (message?.action === "resolveNoteDraft") {
    notesService
      .resolveNoteDraft(message.noteId, message.mode, message.expectedRevision)
      .then(sendResponse)
      .catch((error) => sendResponse(notesService.noteWriteErrorResponse(error)));
    return true;
  }

  if (message?.action === "askQuestion") {
    runManagedAiOperation(
      message.taskId,
      (signal) =>
        qaService.askQuestion({
          bvid: message.bvid,
          page: message.page,
          question: message.question,
          mode: message.mode,
          signal,
          taskId: message.taskId,
        }),
      { autoFinish: true },
    )
      .then(sendResponse)
      .catch((error) => sendResponse(aiErrorResponse(error)));
    return true;
  }

  if (message?.action === "getQaHistory") {
    qaService
      .getQaHistory(message.bvid, message.page)
      .then(sendResponse)
      .catch((error) => sendResponse({ success: false, error: error.message }));
    return true;
  }

  if (message?.action === "deleteQaEntry") {
    qaService
      .deleteQaEntry(message.id)
      .then(sendResponse)
      .catch((error) => sendResponse({ success: false, error: error.message }));
    return true;
  }

  if (message?.action === "checkVideoAvailable") {
    handleCheckVideoAvailable(message.bvid)
      .then(sendResponse)
      // 检查本身出错不该挡住用户，放行让 B 站自己说话。
      .catch(() => sendResponse({ available: true }));
    return true;
  }

  if (message?.action === "exportLearningBackup") {
    notesService
      .exportLearningBackup()
      .then(sendResponse)
      .catch((error) => sendResponse({ success: false, error: error.message }));
    return true;
  }

  if (message?.action === "importLearningBackup") {
    notesService
      .importLearningBackup(message.backup)
      .then(sendResponse)
      .catch((error) => sendResponse({ success: false, error: error.message }));
    return true;
  }

  return false;
});

// ============================================================
// 模型调用
// ============================================================

const promptFileCache = new Map();

async function loadPromptSection(fileName, heading, variables = {}) {
  let markdown = promptFileCache.get(fileName);
  if (!markdown) {
    const response = await fetch(chrome.runtime.getURL(`prompts/${fileName}`));
    if (!response.ok) {
      throw new Error(`提示词文件读取失败：${fileName}`);
    }
    markdown = await response.text();
    promptFileCache.set(fileName, markdown);
  }
  return BILI_AI.extractPromptSection(markdown, heading, variables);
}

/**
 * 用户可以填任意 API 地址，而 MV3 不允许 fetch 未授权的域名。
 * 域名在安装时是未知的，所以走 optional_host_permissions 在设置页运行时申请。
 */
async function ensureHostPermission(baseUrl) {
  const origin = BILI_SETTINGS.originOf(baseUrl);
  if (!origin) {
    const error = new Error("API 地址不合法，请到设置页检查。");
    error.code = "INVALID_BASE_URL";
    throw error;
  }

  const granted = await chrome.permissions.contains({ origins: [origin] });
  if (!granted) {
    const error = new Error(
      `扩展还没有访问 ${origin} 的权限。请打开设置页，点「保存并授权」。`,
    );
    error.code = "NEED_HOST_PERMISSION";
    throw error;
  }
}

// ============================================================
// 逐条改写字幕：顺句（补标点 + 改同音错别字）与翻译（外文 → 中文）
// ============================================================

// 侧边栏按批发过来，这里再兜一道上限，避免异常大的请求。
const REWRITE_MAX_SEGMENTS_PER_CALL = 12;

/**
 * 顺句和翻译走同一条流水线：挑分段 → 查缓存 → 送模型 → 按 id 对回原位 → 写缓存。
 * 真正不同的只有下面这几项；prepare 按本次字幕算出提示词变量和对齐守卫。
 */
const REWRITE_TASKS = Object.freeze({
  polish: {
    label: "顺句",
    cacheKey: "polished",
    promptFile: "punctuate.md",
    // 原地补标点，输出量跟着输入走，再加上 JSON 结构和 id 的开销。
    tokenRatio: 1.5,
    async prepare() {
      return {
        variables: {},
        align: (parsed, todo) => {
          const { polished, rejected } = BILI_AI.alignPolishedSegments(parsed, todo);
          return { accepted: polished, rejected };
        },
      };
    },
  },
  translate: {
    label: "翻译",
    cacheKey: "translated",
    promptFile: "translation.md",
    // 中英互译字符数会变，按字符估 token 时统一放宽。
    tokenRatio: 2,
    async prepare(transcript) {
      // 方向由字幕轨语种决定：中文字幕译成英文，外文字幕译成中文。
      const toEnglish = BILI_TRANSCRIPT.isChineseSubtitle(transcript.language);
      const targetLang = toEnglish ? "en" : "zh";
      return {
        variables: {
          targetLangName: toEnglish ? "英文" : "简体中文",
          langRules: await loadPromptSection(
            "translation.md",
            toEnglish ? "英文规则" : "中文规则",
          ),
        },
        align: (parsed, todo) => {
          const { translated, rejected } = BILI_AI.alignTranslatedSegments(
            parsed,
            todo,
            { targetLang },
          );
          return { accepted: translated, rejected };
        },
      };
    },
  },
});

async function handleSegmentRewrite(
  kind,
  bvidInput,
  { page = 1, segmentIds = [], signal } = {},
) {
  const task = REWRITE_TASKS[kind];
  const bvid = (BILI_API.parseSourceId || BILI_API.parseBvid)(bvidInput);
  if (!bvid) {
    return { success: false, error: "INVALID_BVID", message: "没有识别到 BV 号。" };
  }
  const pageNumber = Number(page) > 0 ? Math.floor(Number(page)) : 1;

  const cached = await BILI_CACHE.load(bvid, { page: pageNumber });
  const transcript = cached?.segments?.length
    ? { ...cached, success: true }
    : await ensureTranscript(bvid, pageNumber);
  if (!transcript.success) return transcript;

  const requested = new Set((segmentIds || []).map(String));
  const segments = (transcript.segments || [])
    .filter((segment) => requested.has(segment.id))
    .slice(0, REWRITE_MAX_SEGMENTS_PER_CALL);
  if (!segments.length) {
    return { success: false, error: "NO_SEGMENTS", message: "没有需要处理的分段。" };
  }

  const done = cached?.[task.cacheKey] || {};
  const todo = segments.filter((segment) => !done[segment.id]);
  if (!todo.length) {
    const hit = {};
    for (const segment of segments) hit[segment.id] = done[segment.id];
    return { success: true, fromCache: true, [task.cacheKey]: hit };
  }

  try {
    throwIfTaskCanceled(signal);
    const { variables: extraVariables, align } = await task.prepare(transcript);
    const payload = {
      segments: todo.map((segment) => ({ id: segment.id, text: segment.text })),
    };
    const variables = {
      ...extraVariables,
      videoTitle: transcript.videoInfo?.title || "未知",
      segmentsJson: JSON.stringify(payload),
    };
    const [systemPrompt, userPrompt] = await Promise.all([
      loadPromptSection(task.promptFile, "系统提示词", variables),
      loadPromptSection(task.promptFile, "用户提示词", variables),
    ]);

    const { text } = await requestAiCompletion({
      maxTokens: BILI_AI.estimateOutputTokens(variables.segmentsJson.length, {
        ratio: task.tokenRatio,
        floor: 2048,
      }),
      // 两者都是照着原文做的，不是创作，温度越低越贴近原意。
      temperature: 0.2,
      responseFormat: { type: "json_object" },
      signal,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    });

    const { accepted, rejected } = align(BILI_AI.parseLooseJson(text), todo);
    throwIfTaskCanceled(signal);
    if (rejected.length) {
      debugLog(`[Bilibili Digest] ${task.label}丢弃的条目：`, rejected);
    }

    // 这些批次是并发跑的，读—改—写要走串行队列，否则会互相覆盖。
    const saved = await updateCache(bvid, pageNumber, (current) => ({
      ...current,
      ...persistable(transcript),
      [task.cacheKey]: { ...(current[task.cacheKey] || {}), ...accepted },
    }));

    // 命中缓存的那部分也一并回给侧边栏，它只认返回值。
    const response = { ...accepted };
    for (const segment of segments) {
      if (!response[segment.id] && saved[task.cacheKey][segment.id]) {
        response[segment.id] = saved[task.cacheKey][segment.id];
      }
    }
    return { success: true, fromCache: false, [task.cacheKey]: response, rejected };
  } catch (error) {
    console.error(`[Bilibili Digest] ${task.label}失败：`, error);
    return aiErrorResponse(error);
  }
}

const handlePolishSegments = (bvid, options) =>
  handleSegmentRewrite("polish", bvid, options);
const handleTranslateSegments = (bvid, options) =>
  handleSegmentRewrite("translate", bvid, options);

// ============================================================
// 划词解释
// ============================================================

async function handleExplainSelection(selectedText, transcriptContext, videoTitle) {
  const text = String(selectedText || "").trim();
  if (!text) {
    return { success: false, error: "EMPTY_SELECTION", message: "没有选中任何文字。" };
  }

  try {
    const variables = {
      videoTitle: videoTitle || "未知",
      selectedText: text.slice(0, 1000),
      transcriptContext: String(transcriptContext || "").slice(0, 4000) || "无",
    };
    const [systemPrompt, userPrompt] = await Promise.all([
      loadPromptSection("explain.md", "系统提示词", variables),
      loadPromptSection("explain.md", "用户提示词", variables),
    ]);

    const { text: explanation } = await requestAiCompletion({
      maxTokens: 1024,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    });
    return { success: true, explanation: explanation.trim() };
  } catch (error) {
    console.error("[Bilibili Digest] 划词解释失败：", error);
    return aiErrorResponse(error);
  }
}

// 开新标签页前先问一句视频还在不在，免得用户等页面加载完才看到「稿件不可见」。
// 判不准时一律放行：拦下还能看的视频比多开一个标签页糟糕得多。
async function handleCheckVideoAvailable(bvidInput) {
  const bvid = (BILI_API.parseSourceId || BILI_API.parseBvid)(bvidInput);
  if (!bvid) return { available: false, message: "这条笔记没有记下有效的视频号。" };

  if (String(bvid).startsWith("youtube:")) return { available: true };

  try {
    await BILI_API.fetchVideoInfo(bvid);
    return { available: true };
  } catch (error) {
    if (error?.code === "VIDEO_UNAVAILABLE") {
      return { available: false, message: "视频已下架，无法查看原视频。" };
    }
    return { available: true };
  }
}
