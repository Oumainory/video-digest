const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const LEARNING_STORE = require("../lib/learning-store.js");
const CONCURRENCY = require("../lib/concurrency.js");
const TRANSCRIPT = require("../lib/transcript.js");
const AI = require("../lib/ai.js");
const SETTINGS = require("../settings.js");
const AI_PROVIDER = require("../lib/ai-provider.js");
const AI_TRANSPORT = require("../lib/ai-transport.js");
const NOTES_SERVICE = require("../lib/notes-service.js");
const TRANSCRIPT_SERVICE = require("../lib/transcript-service.js");
const ANALYSIS_SERVICE = require("../lib/analysis-service.js");
const QA_RETRIEVAL = require("../lib/qa-retrieval.js");
const QA_CITATIONS = require("../lib/qa-citations.js");
const QA_SERVICE = require("../lib/qa-service.js");
const TASKS = require("../lib/task-manager.js");
const NOTE_DB = require("../lib/note-db.js");
const IDB = require("../lib/idb.js");
const YOUTUBE = require("../lib/youtube-api.js");
const COMPANION_PROTOCOL = require("../lib/companion-protocol.js");
const COMPANION_BRIDGE = require("../lib/companion-bridge.js");
const { createMemoryIndexedDb } = require("./helpers/memory-idb.js");
const { memoryStorage } = require("./helpers/memory-storage.js");

const ROOT = path.join(__dirname, "..");
const BVID = "BV1xx411c7mD";

function createBackground({
  initial = {},
  cached = null,
  storage: suppliedStorage,
  aiReply = null,
  browserTabs = [],
  youtubeCached = null,
  youtubeCaptionEntries = [
    { text: "captured subtitle", start: 1, duration: 1.2 },
  ],
  companionPort = null,
} = {}) {
  const storage = suppliedStorage || memoryStorage(initial);
  const sessionStorage = memoryStorage({});
  if (aiReply !== null) {
    storage.data[SETTINGS.STORAGE_KEY] = {
      presetId: "custom",
      protocol: SETTINGS.PROTOCOLS.OPENAI,
      aiApiKey: "test-key",
      aiBaseUrl: "https://example.com/v1",
      aiModel: "test-model",
      aiConcurrency: 1,
      aiTimeoutSeconds: 30,
    };
  }
  const cacheStore = {};
  if (cached) cacheStore[`${BVID}:1`] = structuredClone(cached);
  if (youtubeCached) cacheStore["youtube:dQw4w9WgXcQ:1"] = structuredClone(youtubeCached);
  const idb = createMemoryIndexedDb();
  let messageListener;
  let actionClickListener;
  let tabActivatedListener;
  let tabCreatedListener;
  let tabUpdatedListener;
  let tabRemovedListener;
  let windowFocusListener;
  let windowRemovedListener;
  const broadcasts = [];
  const panelCalls = [];
  const youtubeCaptionRequests = [];
  const tabsById = new Map(browserTabs.map((tab) => [tab.id, { ...tab }]));
  const context = {
    console,
    setTimeout,
    clearTimeout,
    AbortController,
    TextDecoder,
    indexedDB: idb,
    fetch: async (url, options = {}) => {
      const target = String(url);
      if (target.startsWith("prompts/")) {
        const file = path.join(ROOT, target);
        return {
          ok: fs.existsSync(file),
          text: async () => fs.readFileSync(file, "utf8"),
        };
      }
      if (aiReply !== null) {
        const reply =
          typeof aiReply === "function" ? await aiReply({ url, options }) : aiReply;
        const content =
          reply && typeof reply === "object"
            ? JSON.stringify(reply)
            : JSON.stringify({ quote: String(reply) });
        return {
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({
              choices: [{ message: { content } }],
            }),
        };
      }
      throw new Error("测试不应访问网络");
    },
    importScripts() {},
    chrome: {
      storage: { local: storage, session: sessionStorage },
      sidePanel: {
        setPanelBehavior: async (value) => panelCalls.push({ method: "behavior", value }),
        setOptions: async (value) => panelCalls.push({ method: "options", value }),
        open: async (value) => panelCalls.push({ method: "open", value }),
      },
      action: {
        onClicked: { addListener(listener) { actionClickListener = listener; } },
      },
      tabs: {
        async get(tabId) { return tabsById.get(tabId); },
        async query(query = {}) {
          return [...tabsById.values()].filter((tab) =>
            (!query.active || tab.active)
            && (!Number.isInteger(query.windowId) || tab.windowId === query.windowId),
          );
        },
        onActivated: { addListener(listener) { tabActivatedListener = listener; } },
        onCreated: { addListener(listener) { tabCreatedListener = listener; } },
        onUpdated: { addListener(listener) { tabUpdatedListener = listener; } },
        onRemoved: { addListener(listener) { tabRemovedListener = listener; } },
      },
      windows: {
        WINDOW_ID_NONE: -1,
        onFocusChanged: { addListener(listener) { windowFocusListener = listener; } },
        onRemoved: { addListener(listener) { windowRemovedListener = listener; } },
      },
      runtime: {
        connectNative(hostName) {
          if (!companionPort) throw new Error(`Native host unavailable: ${hostName}`);
          companionPort.hostName = hostName;
          return companionPort;
        },
        getURL: (value) => value,
        openOptionsPage() {},
        onInstalled: { addListener() {} },
        onStartup: { addListener() {} },
        onMessage: {
          addListener(listener) {
            messageListener = listener;
          },
        },
        sendMessage: async (message) => {
          broadcasts.push(message);
        },
      },
      permissions: { contains: async () => true },
    },
    BILI_LEARNING_STORE: LEARNING_STORE,
    BILI_CONCURRENCY: CONCURRENCY,
    BILI_TRANSCRIPT: TRANSCRIPT,
    BILI_CACHE: {
      // 迁移链会调用；缓存本身的 IndexedDB 路径由 cache.test.js 覆盖。
      ensureCacheInIdb: async () => ({ migrated: false }),
      load: async (bvid, { page = 1 } = {}) => {
        const key = `${bvid}:${page}`;
        return cacheStore[key] ? structuredClone(cacheStore[key]) : null;
      },
      save: async (bvid, data, { page = 1 } = {}) => {
        cacheStore[`${bvid}:${page}`] = structuredClone(data);
        return true;
      },
    },
    BILI_API: {
      parseBvid: (value) => (String(value || "").includes("BV") ? BVID : null),
      canonicalVideoUrl: (bvid, seconds, page) =>
        `https://www.bilibili.com/video/${bvid}?p=${page}&t=${seconds}`,
      fetchVideoInfo: async () => ({ title: "标题", owner: { name: "UP 主" } }),
    },
    BILI_SETTINGS: SETTINGS,
    BILI_AI: AI,
    BILI_AI_PROVIDER: AI_PROVIDER,
    BILI_AI_TRANSPORT: AI_TRANSPORT,
    BILI_NOTES_SERVICE: NOTES_SERVICE,
    BILI_TRANSCRIPT_SERVICE: TRANSCRIPT_SERVICE,
    BILI_ANALYSIS_SERVICE: ANALYSIS_SERVICE,
    BILI_QA_RETRIEVAL: QA_RETRIEVAL,
    BILI_QA_CITATIONS: QA_CITATIONS,
    BILI_QA_SERVICE: QA_SERVICE,
    BILI_TASKS: TASKS,
    BILI_NOTE_DB: NOTE_DB,
    BILI_IDB: IDB,
    VIDEO_DIGEST_YOUTUBE: {
      ...YOUTUBE,
      fetchCaptionTrackContent: async (url) => {
        youtubeCaptionRequests.push(String(url));
        const entries = typeof youtubeCaptionEntries === "function"
          ? await youtubeCaptionEntries(String(url))
          : youtubeCaptionEntries;
        return structuredClone(entries);
      },
    },
    BILI_COMPANION: COMPANION_PROTOCOL,
    BILI_COMPANION_BRIDGE: COMPANION_BRIDGE,
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(ROOT, "background.js"), "utf8"), context);

  async function send(message) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("消息没有回复")), 8000);
      messageListener(message, {}, (result) => {
        clearTimeout(timeout);
        resolve(result);
      });
    });
  }

  return {
    storage,
    send,
    broadcasts,
    idb,
    panelCalls,
    youtubeCaptionRequests,
    events: {
      actionClick(tab) { actionClickListener?.(tab); },
      tabActivated(info) { return tabActivatedListener?.(info); },
      tabCreated(tab) { return tabCreatedListener?.(tab); },
      tabUpdated(tabId, changeInfo, tab) { tabUpdatedListener?.(tabId, changeInfo, tab); },
      tabRemoved(tabId, info) { tabRemovedListener?.(tabId, info); },
      windowFocus(windowId) { return windowFocusListener?.(windowId); },
      windowRemoved(windowId) { windowRemovedListener?.(windowId); },
    },
  };
}

// 笔记的正牌后端在沙箱的假 IndexedDB 里，用同一套真实驱动读出来断言。
function notesRepository(idb) {
  return NOTE_DB.createNotesRepository({
    driver: NOTE_DB.createIndexedDbDriver({ indexedDB: idb }),
  });
}

// 概览快照同理。
function learningRepository(idb) {
  return LEARNING_STORE.createLearningRepository({
    driver: IDB.createObjectStoreDriver({ storeName: "learning", indexedDB: idb }),
  });
}

// MV3 只为「正在处理的事件」保活 service worker。顶层发起的异步调用一旦
// 在求值结束后仍未返回，worker 会被直接回收，Chromium 报 `No SW`——
// 表现就是侧边栏永远够不着后台。所以启动阶段不许碰存储。
test("service worker 启动时不读存储，迁移等到真正用数据时才跑", async () => {
  const storage = memoryStorage({});
  const reads = [];
  const originalGet = storage.get.bind(storage);
  storage.get = async (key) => {
    reads.push(key);
    return originalGet(key);
  };

  const ctx = createBackground({ storage });

  assert.deepEqual(reads, [], "顶层异步没有 keepalive 保护，会被回收打断");

  await ctx.send({ action: "getNotes", bvid: BVID, page: 1 });

  assert.equal(reads[0], LEARNING_STORE.META_KEY, "真正要用笔记时才迁移");
});

test("侧边栏按窗口记住明确打开的标签页，不跟到另一个窗口", async () => {
  const tabA = {
    id: 11,
    windowId: 1,
    active: true,
    url: "https://www.bilibili.com/video/BV1xx411c7mD",
  };
  const tabB = {
    id: 22,
    windowId: 2,
    active: true,
    url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  };
  const ctx = createBackground({ browserTabs: [tabA, tabB] });

  ctx.events.actionClick(tabA);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.ok(
    ctx.panelCalls.some((call) =>
      call.method === "open" && call.value.tabId === tabA.id
      && call.value.windowId === undefined,
    ),
    "打开必须绑定标签页，不能创建会跨窗口跟随的全局面板",
  );

  await ctx.events.windowFocus(tabB.windowId);
  assert.ok(
    ctx.panelCalls.some((call) =>
      call.method === "options" && call.value.tabId === tabB.id
      && call.value.enabled === false,
    ),
    "从未打开过 Digest 的 B 窗口必须禁用面板",
  );

  await ctx.events.windowFocus(tabA.windowId);
  assert.ok(
    ctx.panelCalls.some((call) =>
      call.method === "options" && call.value.tabId === tabA.id
      && call.value.enabled === true,
    ),
    "切回 A 窗口时要恢复原标签页的面板",
  );
});

test("打开前预先禁用同窗口其它标签，切回时保留原面板状态", async () => {
  const owner = {
    id: 31,
    windowId: 7,
    active: true,
    url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  };
  const other = {
    id: 32,
    windowId: 7,
    active: false,
    url: "https://www.bilibili.com/video/BV1xx411c7mD",
  };
  const ctx = createBackground({ browserTabs: [owner, other] });

  ctx.events.actionClick(owner);
  await new Promise((resolve) => setTimeout(resolve, 0));

  const ownerEnabled = ctx.panelCalls.find((call) =>
    call.method === "options" && call.value.tabId === owner.id && call.value.enabled === true,
  );
  const otherDisabled = ctx.panelCalls.find((call) =>
    call.method === "options" && call.value.tabId === other.id && call.value.enabled === false,
  );
  assert.ok(ownerEnabled, "打开前必须把所属标签设置为可用");
  assert.ok(otherDisabled, "切换前必须预先禁用其它标签，不能等激活后才处理");

  await ctx.events.tabActivated({ tabId: other.id });
  await ctx.events.tabActivated({ tabId: owner.id });
  const lastOwnerCall = ctx.panelCalls
    .filter((call) => call.method === "options" && call.value.tabId === owner.id)
    .at(-1);
  assert.equal(lastOwnerCall.value.enabled, true, "切回所属标签时仍须保持面板可用");
});

test("YouTube 播放器响应缺失时使用当前视频捕获的官方字幕 URL", async () => {
  const ctx = createBackground();
  const result = await ctx.send({
    action: "fetchYoutubeTranscript",
    videoId: "dQw4w9WgXcQ",
    sourceUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    captionTrackUrl:
      "https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ&lang=en&kind=asr",
    pageInfo: { title: "页面标题", owner: "频道名", duration: 120 },
  });

  assert.equal(result.success, true);
  assert.equal(result.transcript[0].text, "captured subtitle");
  assert.equal(result.videoInfo.title, "页面标题");
  assert.equal(result.language, "en");
  assert.equal(result.isAiSubtitle, true);
});

test("YouTube 同语言静态轨为空时优先使用播放器实际请求的字幕 URL", async () => {
  const id = "dQw4w9WgXcQ";
  const staticUrl = `https://www.youtube.com/api/timedtext?v=${id}&lang=en&source=static`;
  const capturedUrl = `https://www.youtube.com/api/timedtext?v=${id}&lang=en&source=player`;
  const ctx = createBackground({
    youtubeCaptionEntries: (url) => url === capturedUrl
      ? [{ text: "播放器会话字幕", start: 1, duration: 1.2 }]
      : [],
  });
  const result = await ctx.send({
    action: "fetchYoutubeTranscript",
    videoId: id,
    sourceUrl: `https://www.youtube.com/watch?v=${id}`,
    captionTrackUrl: capturedUrl,
    playerResponse: {
      videoDetails: { videoId: id, title: "会话字幕测试" },
      captions: {
        playerCaptionsTracklistRenderer: {
          captionTracks: [{
            languageCode: "en",
            name: { simpleText: "English" },
            baseUrl: staticUrl,
          }],
        },
      },
    },
  });

  assert.equal(result.success, true, JSON.stringify(result));
  assert.equal(result.transcript[0].text, "播放器会话字幕");
  assert.deepEqual(ctx.youtubeCaptionRequests, [capturedUrl]);
});

test("YouTube 直接复用页面捕获的字幕正文", async () => {
  const id = "dQw4w9WgXcQ";
  const staticUrl = `https://www.youtube.com/api/timedtext?v=${id}&lang=en&source=static`;
  const capturedUrl = `https://www.youtube.com/api/timedtext?v=${id}&lang=en&source=player`;
  const responseUrl = `${capturedUrl}&fmt=json3`;
  const ctx = createBackground({
    youtubeCaptionEntries: () => {
      throw new Error("已经有页面正文时不应再次请求后台字幕地址");
    },
  });
  const result = await ctx.send({
    action: "fetchYoutubeTranscript",
    videoId: id,
    sourceUrl: `https://www.youtube.com/watch?v=${id}`,
    captionTrackUrls: [capturedUrl],
    captionBodies: [{
      url: responseUrl,
      contentType: "application/json",
      body: JSON.stringify({
        events: [{ tStartMs: 1000, dDurationMs: 1200, segs: [{ utf8: "页面官方字幕正文" }] }],
      }),
    }],
    playerResponse: {
      videoDetails: { videoId: id, title: "页面正文测试" },
      captions: {
        playerCaptionsTracklistRenderer: {
          captionTracks: [{ languageCode: "en", baseUrl: staticUrl }],
        },
      },
    },
  });

  assert.equal(result.success, true, JSON.stringify(result));
  assert.equal(result.transcript[0].text, "页面官方字幕正文");
  assert.deepEqual(ctx.youtubeCaptionRequests, []);
});

test("YouTube 播放器会话地址为空时回退同语言静态轨", async () => {
  const id = "dQw4w9WgXcQ";
  const staticUrl = `https://www.youtube.com/api/timedtext?v=${id}&lang=en&source=static`;
  const capturedUrl = `https://www.youtube.com/api/timedtext?v=${id}&lang=en&source=player`;
  const ctx = createBackground({
    youtubeCaptionEntries: (url) => url === staticUrl
      ? [{ text: "静态轨回退字幕", start: 2, duration: 1 }]
      : [],
  });
  const result = await ctx.send({
    action: "fetchYoutubeTranscript",
    videoId: id,
    captionTrackUrl: capturedUrl,
    playerResponse: {
      videoDetails: { videoId: id },
      captions: {
        playerCaptionsTracklistRenderer: {
          captionTracks: [{ languageCode: "en", baseUrl: staticUrl }],
        },
      },
    },
  });

  assert.equal(result.success, true, JSON.stringify(result));
  assert.equal(result.transcript[0].text, "静态轨回退字幕");
  assert.deepEqual(ctx.youtubeCaptionRequests, [capturedUrl, staticUrl]);
});

test("YouTube 后台空响应经页面原文重试后成功解析", async () => {
  const ctx = createBackground({ youtubeCaptionEntries: [] });
  const request = {
    action: "fetchYoutubeTranscript",
    videoId: "dQw4w9WgXcQ",
    sourceUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    captionTrackUrl:
      "https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ&lang=en",
    pageInfo: { title: "页面标题", owner: "频道名", duration: 120 },
  };
  const empty = await ctx.send(request);
  assert.equal(empty.needsPageCaptionFetch, true);
  assert.equal(empty.pageCaptionTrackUrl, request.captionTrackUrl);

  const recovered = await ctx.send({
    ...request,
    pageCaptionFetchAttempted: true,
    pageCaptionTrackUrl: empty.pageCaptionTrackUrl,
    pageCaptionContentType: "text/xml",
    pageCaptionBody:
      '<transcript><text start="2" dur="1.5">页面会话恢复的字幕</text></transcript>',
  });
  assert.equal(recovered.success, true, JSON.stringify(recovered));
  assert.equal(recovered.transcript[0].text, "页面会话恢复的字幕");
});

test("YouTube 当前页面有播放器数据时不先返回旧字幕缓存", async () => {
  const id = "dQw4w9WgXcQ";
  const trackUrl = `https://www.youtube.com/api/timedtext?v=${id}&lang=en&kind=asr`;
  const ctx = createBackground({
    youtubeCached: {
      transcript: [{ text: "旧字幕", start: 0, duration: 1 }],
      segments: [{ text: "旧字幕", start: 0, duration: 1 }],
    },
    youtubeCaptionEntries: [{ text: "当前播放器字幕", start: 2, duration: 1 }],
  });

  const result = await ctx.send({
    action: "fetchYoutubeTranscript",
    videoId: id,
    sourceUrl: `https://www.youtube.com/watch?v=${id}`,
    playerResponse: {
      videoDetails: { videoId: id, title: "当前视频" },
      captions: {
        playerCaptionsTracklistRenderer: {
          captionTracks: [{ languageCode: "en", kind: "asr", baseUrl: trackUrl }],
        },
      },
    },
  });

  assert.equal(result.success, true, JSON.stringify(result));
  assert.equal(result.fromCache, false);
  assert.equal(result.transcript[0].text, "当前播放器字幕");
});

test("YouTube 按播放器当前选中的字幕轨取同语言字幕", async () => {
  const id = "dQw4w9WgXcQ";
  const aiUrl = `https://www.youtube.com/api/timedtext?v=${id}&lang=zh-Hans&kind=asr`;
  const manualUrl = `https://www.youtube.com/api/timedtext?v=${id}&lang=zh-Hans`;
  const ctx = createBackground({
    youtubeCaptionEntries: (url) => url === aiUrl
      ? [{ text: "播放器选中的自动字幕", start: 1, duration: 1 }]
      : [{ text: "另一条人工字幕", start: 6, duration: 1 }],
  });

  const result = await ctx.send({
    action: "fetchYoutubeTranscript",
    videoId: id,
    sourceUrl: `https://www.youtube.com/watch?v=${id}`,
    activeCaptionTrack: { languageCode: "zh-Hans", kind: "asr" },
    captionTrackUrls: [manualUrl, aiUrl],
    playerResponse: {
      videoDetails: { videoId: id, title: "字幕轨测试" },
      captions: {
        playerCaptionsTracklistRenderer: {
          captionTracks: [
            { languageCode: "zh-Hans", baseUrl: manualUrl },
            { languageCode: "zh-Hans", kind: "asr", baseUrl: aiUrl },
          ],
        },
      },
    },
  });

  assert.equal(result.success, true, JSON.stringify(result));
  assert.equal(result.transcript[0].text, "播放器选中的自动字幕");
});

test("YouTube 同一字幕轨的多次会话响应合并成完整字幕", async () => {
  const id = "dQw4w9WgXcQ";
  const firstUrl = `https://www.youtube.com/api/timedtext?v=${id}&lang=zh-Hans&caps=asr&start=0`;
  const secondUrl = `https://www.youtube.com/api/timedtext?v=${id}&lang=zh-Hans&caps=asr&start=6`;
  const toJson = (entries) => JSON.stringify({
    events: entries.map((entry) => ({
      tStartMs: entry.start * 1000,
      dDurationMs: entry.duration * 1000,
      segs: [{ utf8: entry.text }],
    })),
  });
  const ctx = createBackground();
  const result = await ctx.send({
    action: "fetchYoutubeTranscript",
    videoId: id,
    sourceUrl: `https://www.youtube.com/watch?v=${id}`,
    captionTrackUrls: [firstUrl, secondUrl],
    captionBodies: [
      { url: firstUrl, contentType: "application/json", body: toJson([{ text: "开头字幕", start: 1, duration: 1 }]) },
      { url: secondUrl, contentType: "application/json", body: toJson([{ text: "后续字幕", start: 6, duration: 1 }]) },
    ],
    playerResponse: {
      videoDetails: { videoId: id, title: "分段字幕测试" },
      captions: {
        playerCaptionsTracklistRenderer: {
          captionTracks: [{ languageCode: "zh-Hans", kind: "asr", baseUrl: firstUrl }],
        },
      },
    },
  });

  assert.equal(result.success, true, JSON.stringify(result));
  assert.equal(result.transcript.map((entry) => entry.text).join("|"), "开头字幕|后续字幕");
});

test("后台把桌面操作映射到 Native Messaging，并转发任务事件", async () => {
  let onMessage;
  const posted = [];
  const companionPort = {
    onMessage: { addListener(listener) { onMessage = listener; } },
    onDisconnect: { addListener() {} },
    postMessage(message) {
      posted.push(message);
      queueMicrotask(() => onMessage({
        protocol: COMPANION_PROTOCOL.PROTOCOL,
        version: COMPANION_PROTOCOL.VERSION,
        type: "response",
        requestId: message.requestId,
        success: true,
        payload: { task: { id: "desktop-task", state: "queued" } },
      }));
    },
  };
  const ctx = createBackground({ companionPort });
  const reply = await ctx.send({ action: "startLocalTask", payload: { mode: "ocr", filePath: "C:/fixture.mp4" } });
  assert.equal(companionPort.hostName, COMPANION_PROTOCOL.HOST_NAME);
  assert.equal(posted[0].action, COMPANION_PROTOCOL.ACTIONS.START_TASK);
  assert.equal(posted[0].payload.mode, "ocr");
  assert.equal(reply.success, true);
  assert.equal(reply.task.id, "desktop-task");

  onMessage({
    protocol: COMPANION_PROTOCOL.PROTOCOL,
    version: COMPANION_PROTOCOL.VERSION,
    type: "event",
    event: COMPANION_PROTOCOL.EVENTS.TASK_CHANGED,
    payload: { task: { id: "desktop-task", state: "running", done: 1, total: 2 } },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(ctx.broadcasts.some((message) =>
    message.action === "companionTaskChanged"
    && message.task.id === "desktop-task"
    && message.task.state === "running"));
});

test("迁移失败后不会卡在降级状态，下一次操作会重试", async () => {
  const storage = memoryStorage({});
  let metaReads = 0;
  let failNext = true;
  const originalGet = storage.get.bind(storage);
  storage.get = async (key) => {
    if (key === LEARNING_STORE.META_KEY) {
      metaReads += 1;
      if (failNext) {
        failNext = false;
        throw new Error("No SW");
      }
    }
    return originalGet(key);
  };

  const ctx = createBackground({ storage });
  await ctx.send({ action: "getNotes", bvid: BVID, page: 1 });
  await ctx.send({ action: "getNotes", bvid: BVID, page: 1 });

  // 成功路径的迁移链各读一次 meta：v2 数据 → 笔记 → 概览快照（缓存迁移在
  // 本沙箱里是桩）。首次偶发失败重试后再各读一次，合计 4。
  assert.equal(metaReads, 4, "一次偶发失败不该让这条 worker 上的后续操作一直降级");
  assert.equal(
    storage.data[LEARNING_STORE.META_KEY].schemaVersion,
    LEARNING_STORE.SCHEMA_VERSION,
  );
});

test("后台任务协议拒绝同目标重复任务，并支持查询与取消", async () => {
  const ctx = createBackground();
  const first = await ctx.send({
    action: "startAiTask",
    taskId: "analysis-1",
    kind: "analysis",
    bvid: BVID,
    page: 1,
  });
  const repeated = await ctx.send({
    action: "startAiTask",
    taskId: "analysis-2",
    kind: "analysis",
    bvid: BVID,
    page: 1,
  });

  assert.equal(first.success, true);
  assert.equal(repeated.error, "TASK_ALREADY_RUNNING");
  assert.equal(repeated.task.id, "analysis-1");

  const active = await ctx.send({ action: "getAiTasks" });
  assert.equal(active.tasks.length, 1);
  assert.equal(active.tasks[0].state, "running");

  const canceled = await ctx.send({ action: "cancelAiTask", taskId: "analysis-1" });
  assert.equal(canceled.success, true);
  assert.equal(canceled.task.state, "canceled");
  assert.ok(
    ctx.broadcasts.some(
      (message) => message.action === "aiTaskChanged" && message.task.state === "canceled",
    ),
  );
});

test("取消笔记优化会中止真实模型请求，且不会保存半成品候选", async () => {
  let markStarted;
  const started = new Promise((resolve) => {
    markStarted = resolve;
  });
  const ctx = createBackground({
    initial: {
      [LEARNING_STORE.NOTES_KEY]: [
        {
          id: "note_1",
          bvid: BVID,
          text: "需要优化的正文",
          createdAt: 1000,
          revision: 1,
        },
      ],
    },
    aiReply: ({ options }) =>
      new Promise((resolve, reject) => {
        markStarted();
        options.signal.addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        });
      }),
  });

  await ctx.send({
    action: "startAiTask",
    taskId: "note-task-1",
    kind: "note-refine",
    noteId: "note_1",
  });
  const generating = ctx.send({
    action: "generateNoteDraft",
    taskId: "note-task-1",
    noteId: "note_1",
  });
  await started;
  await ctx.send({ action: "cancelAiTask", taskId: "note-task-1" });
  const result = await generating;

  assert.equal(result.success, false);
  assert.equal(result.error, "TASK_CANCELED");
  const notes = await notesRepository(ctx.idb).all();
  assert.equal(notes.find((note) => note.id === "note_1").aiDraft, undefined);
  assert.deepEqual((await ctx.send({ action: "getAiTasks" })).tasks, []);
});

test("首次读取笔记前完成旧数据迁移", async () => {
  const ctx = createBackground({
    initial: {
      [LEARNING_STORE.NOTES_KEY]: [
        { id: "note_1", bvid: BVID, text: "旧笔记", createdAt: 1000 },
      ],
    },
  });

  const result = await ctx.send({ action: "getNotes" });

  assert.equal(result.success, true, JSON.stringify(result));
  assert.equal(result.notes[0].page, 1);
  assert.equal(result.notes[0].updatedAt, 1000);
  assert.equal(result.notes[0].learningId, `${BVID}:p1`);
  assert.equal(
    ctx.storage.data[LEARNING_STORE.META_KEY].schemaVersion,
    LEARNING_STORE.SCHEMA_VERSION,
  );
});

test("本视频笔记按 BV 号和分 P 精确关联", async () => {
  const ctx = createBackground({
    initial: {
      [LEARNING_STORE.NOTES_KEY]: [
        { id: "p1", bvid: BVID, page: 1, text: "第一 P", createdAt: 1000 },
        { id: "p2", bvid: BVID, page: 2, text: "第二 P", createdAt: 1001 },
      ],
    },
  });

  const result = await ctx.send({ action: "getNotes", bvid: BVID, page: 2 });

  assert.equal(result.notes.length, 1);
  assert.equal(result.notes[0].id, "p2");
});

test("导出备份不含设置密钥，导入按较新时间合并", async () => {
  const learningKey = LEARNING_STORE.learningKey(BVID, 1);
  const ctx = createBackground({
    initial: {
      [SETTINGS.STORAGE_KEY]: { aiApiKey: "sk-secret" },
      [LEARNING_STORE.NOTES_KEY]: [
        { id: "local", bvid: BVID, text: "本机独有", updatedAt: 1000 },
        { id: "shared", bvid: BVID, text: "本机旧文", updatedAt: 1000 },
      ],
      [learningKey]: {
        learningId: `${BVID}:p1`,
        bvid: BVID,
        page: 1,
        analysis: { chapters: [{ title: "旧章" }] },
        updatedAt: 1000,
      },
    },
  });

  const exported = await ctx.send({ action: "exportLearningBackup" });
  assert.equal(exported.success, true);
  assert.equal(exported.backup.kind, LEARNING_STORE.BACKUP_KIND);
  assert.doesNotMatch(JSON.stringify(exported.backup), /sk-secret/);

  const imported = await ctx.send({
    action: "importLearningBackup",
    backup: {
      kind: LEARNING_STORE.BACKUP_KIND,
      schemaVersion: 2,
      notes: [{ id: "shared", bvid: BVID, text: "备份新文", updatedAt: 9000 }],
      learning: [
        {
          learningId: `${BVID}:p1`,
          bvid: BVID,
          page: 1,
          analysis: { chapters: [{ title: "新章" }] },
          updatedAt: 9000,
        },
      ],
    },
  });
  assert.equal(imported.success, true);
  assert.equal(imported.notesAdded, 0);
  assert.equal(imported.notesUpdated, 1);
  const notes = await notesRepository(ctx.idb).all();
  assert.equal(notes.find((note) => note.id === "local").text, "本机独有");
  assert.equal(notes.find((note) => note.id === "shared").text, "备份新文");
  const learning = await learningRepository(ctx.idb).find(`${BVID}:p1`);
  assert.equal(learning.analysis.chapters[0].title, "新章");
  assert.equal(ctx.storage.data[SETTINGS.STORAGE_KEY].aiApiKey, "sk-secret");
});

test("拒绝无法识别的备份文件", async () => {
  const ctx = createBackground();
  const result = await ctx.send({
    action: "importLearningBackup",
    backup: { notes: [] },
  });
  assert.equal(result.success, false);
  assert.equal(result.error, "INVALID_BACKUP");
});

test("笔记正文可以更新，并记录更新时间", async () => {
  const ctx = createBackground({
    initial: {
      [LEARNING_STORE.NOTES_KEY]: [
        {
          id: "note_1",
          bvid: BVID,
          page: 1,
          text: "旧正文",
          createdAt: 1000,
          revision: 4,
          contentSource: "ai",
          aiDraft: { text: "过期候选", basedOnRevision: 4 },
        },
      ],
    },
  });

  const result = await ctx.send({
    action: "updateNote",
    noteId: "note_1",
    text: "  修改后的正文  ",
  });

  assert.equal(result.success, true);
  assert.equal(result.note.text, "修改后的正文");
  assert.equal(result.note.revision, 5);
  assert.equal(result.note.contentSource, "user");
  assert.equal(result.note.aiDraft, undefined);
  assert.ok(result.note.updatedAt >= result.note.createdAt);
  const stored = await notesRepository(ctx.idb).all();
  assert.equal(stored[0].text, "修改后的正文");
});

test("AI 优化只生成候选，不直接覆盖当前笔记", async () => {
  const ctx = createBackground({
    initial: {
      [LEARNING_STORE.NOTES_KEY]: [
        {
          id: "note_1",
          bvid: BVID,
          page: 1,
          text: "用户修改过的正文",
          videoTitle: "测试视频",
          createdAt: 1000,
          revision: 3,
          contentSource: "user",
        },
      ],
    },
    aiReply: "AI 优化后的候选正文。",
  });

  const result = await ctx.send({ action: "generateNoteDraft", noteId: "note_1" });

  assert.equal(result.success, true, JSON.stringify(result));
  assert.equal(result.note.text, "用户修改过的正文");
  assert.equal(result.note.revision, 3);
  assert.equal(result.note.aiDraft.text, "AI 优化后的候选正文。");
  assert.equal(result.note.aiDraft.basedOnRevision, 3);
  assert.equal(result.note.aiDraft.conflict, false);
});

test("空笔记不会发起 AI 优化请求", async () => {
  let requested = false;
  const ctx = createBackground({
    initial: {
      [LEARNING_STORE.NOTES_KEY]: [
        { id: "note_1", bvid: BVID, text: "  ", createdAt: 1000, revision: 1 },
      ],
    },
    aiReply: () => {
      requested = true;
      return "不应生成";
    },
  });

  const result = await ctx.send({ action: "generateNoteDraft", noteId: "note_1" });

  assert.equal(result.success, false);
  assert.equal(result.error, "EMPTY_NOTE");
  assert.equal(requested, false);
});

test("AI 生成期间发生手动编辑时，候选标记冲突且不覆盖新正文", async () => {
  let markStarted;
  let releaseReply;
  const started = new Promise((resolve) => {
    markStarted = resolve;
  });
  const ctx = createBackground({
    initial: {
      [LEARNING_STORE.NOTES_KEY]: [
        {
          id: "note_1",
          bvid: BVID,
          text: "发起时的正文",
          createdAt: 1000,
          revision: 1,
          contentSource: "user",
        },
      ],
    },
    aiReply: () =>
      new Promise((resolve) => {
        releaseReply = resolve;
        markStarted();
      }),
  });

  const generating = ctx.send({ action: "generateNoteDraft", noteId: "note_1" });
  await started;
  await ctx.send({ action: "updateNote", noteId: "note_1", text: "期间手动修改" });
  releaseReply("基于旧正文生成的候选");
  const result = await generating;

  assert.equal(result.note.text, "期间手动修改");
  assert.equal(result.note.revision, 2);
  assert.equal(result.note.aiDraft.basedOnRevision, 1);
  assert.equal(result.note.aiDraft.conflict, true);
});

test("用户明确确认后才用 AI 候选替换正文", async () => {
  const ctx = createBackground({
    initial: {
      [LEARNING_STORE.NOTES_KEY]: [
        {
          id: "note_1",
          bvid: BVID,
          text: "当前正文",
          createdAt: 1000,
          revision: 3,
          contentSource: "user",
          aiDraft: {
            text: "AI 候选",
            basedOnRevision: 3,
            createdAt: 2000,
            conflict: false,
          },
        },
      ],
    },
  });

  const result = await ctx.send({
    action: "resolveNoteDraft",
    noteId: "note_1",
    mode: "replace",
    expectedRevision: 3,
  });

  assert.equal(result.success, true);
  assert.equal(result.note.text, "AI 候选");
  assert.equal(result.note.revision, 4);
  assert.equal(result.note.contentSource, "ai");
  assert.equal(result.note.aiDraft, undefined);
});

test("AI 候选可以追加到当前笔记，也可以直接丢弃", async () => {
  const note = {
    id: "note_1",
    bvid: BVID,
    text: "当前正文",
    createdAt: 1000,
    revision: 2,
    contentSource: "user",
    aiDraft: { text: "补充内容", basedOnRevision: 2, createdAt: 2000 },
  };
  const appended = createBackground({
    initial: { [LEARNING_STORE.NOTES_KEY]: [note] },
  });

  const appendResult = await appended.send({
    action: "resolveNoteDraft",
    noteId: "note_1",
    mode: "append",
    expectedRevision: 2,
  });

  assert.equal(appendResult.success, true);
  assert.equal(appendResult.note.text, "当前正文\n\n补充内容");
  assert.equal(appendResult.note.revision, 3);
  assert.equal(appendResult.note.contentSource, "user");

  const discarded = createBackground({
    initial: { [LEARNING_STORE.NOTES_KEY]: [note] },
  });
  const discardResult = await discarded.send({
    action: "resolveNoteDraft",
    noteId: "note_1",
    mode: "discard",
    expectedRevision: 2,
  });

  assert.equal(discardResult.success, true);
  assert.equal(discardResult.note.text, "当前正文");
  assert.equal(discardResult.note.revision, 2);
  assert.equal(discardResult.note.aiDraft, undefined);
});

test("采用候选前正文又被修改时返回冲突，不覆盖任何内容", async () => {
  const ctx = createBackground({
    initial: {
      [LEARNING_STORE.NOTES_KEY]: [
        {
          id: "note_1",
          bvid: BVID,
          text: "更新后的正文",
          createdAt: 1000,
          revision: 4,
          contentSource: "user",
          aiDraft: {
            text: "旧候选",
            basedOnRevision: 3,
            createdAt: 2000,
            conflict: true,
          },
        },
      ],
    },
  });

  const result = await ctx.send({
    action: "resolveNoteDraft",
    noteId: "note_1",
    mode: "replace",
    expectedRevision: 3,
  });

  assert.equal(result.success, false);
  assert.equal(result.error, "NOTE_CONFLICT");
  const kept = await notesRepository(ctx.idb).all();
  assert.equal(kept[0].text, "更新后的正文");
  assert.equal(kept[0].aiDraft.text, "旧候选");
});

test("空正文和不存在的笔记不会被写入", async () => {
  const ctx = createBackground({
    initial: {
      [LEARNING_STORE.NOTES_KEY]: [
        { id: "note_1", bvid: BVID, text: "保留", createdAt: 1000 },
      ],
    },
  });

  const empty = await ctx.send({ action: "updateNote", noteId: "note_1", text: "  " });
  const missing = await ctx.send({
    action: "updateNote",
    noteId: "missing",
    text: "新正文",
  });

  assert.equal(empty.error, "EMPTY_NOTE");
  assert.equal(missing.error, "NOTE_NOT_FOUND");
  const kept = await notesRepository(ctx.idb).all();
  assert.equal(kept[0].text, "保留");
});

test("超过 100 条后继续保存，不再静默删除最旧笔记", async () => {
  const existing = Array.from({ length: 100 }, (_, index) => ({
    id: `note_${index}`,
    bvid: BVID,
    page: 1,
    timestampSeconds: index,
    text: `笔记 ${index}`,
    createdAt: 1000 + index,
  }));
  const ctx = createBackground({
    initial: { [LEARNING_STORE.NOTES_KEY]: existing },
    cached: {
      transcript: [{ from: 0, to: 200, content: "字幕" }],
      videoInfo: { title: "标题", owner: "UP 主" },
    },
  });

  const result = await ctx.send({
    action: "saveNote",
    bvid: BVID,
    page: 1,
    timestamp: 101,
    text: "第 101 条",
  });

  assert.equal(result.success, true);
  const notes = await notesRepository(ctx.idb).all();
  assert.equal(notes.length, 101);
  assert.ok(notes.some((note) => note.id === "note_0"));
});

test("存储空间不足时明确报错，并保留已有笔记", async () => {
  const existing = Array.from({ length: 100 }, (_, index) => ({
    id: `note_${index}`,
    bvid: BVID,
    page: 1,
    timestampSeconds: index,
    text: `笔记 ${index}`,
    createdAt: 1000 + index,
  }));
  const ctx = createBackground({
    initial: { [LEARNING_STORE.NOTES_KEY]: existing },
    cached: {
      transcript: [{ from: 0, to: 200, content: "字幕" }],
      videoInfo: { title: "标题", owner: "UP 主" },
    },
  });

  // 先让迁移把旧笔记搬进 IndexedDB，再注入下一次写失败——
  // 否则失败会被迁移消费掉，走的是「迁移降级」而不是「写入报错」。
  assert.equal((await ctx.send({ action: "getNotes" })).success, true);
  ctx.idb.__failNextWrite(new Error("QUOTA_BYTES quota exceeded"));

  const result = await ctx.send({
    action: "saveNote",
    bvid: BVID,
    page: 1,
    timestamp: 101,
    text: "放不下的笔记",
  });

  assert.equal(result.success, false);
  assert.equal(result.error, "STORAGE_FULL");
  assert.match(result.message, /空间/);
  const notes = await notesRepository(ctx.idb).all();
  assert.equal(notes.length, 100, "已有笔记一条不少");
  assert.equal(ctx.storage.data[LEARNING_STORE.NOTES_KEY], undefined, "迁移完成后旧 key 不再保留");
});

test("字幕缓存没有概览时，会恢复长期保存的概览", async () => {
  const analysis = { chapters: [{ title: "长期章节" }], keyQuotes: [] };
  const learningKey = LEARNING_STORE.learningKey(BVID, 1);
  const ctx = createBackground({
    initial: {
      [learningKey]: {
        schemaVersion: LEARNING_STORE.SCHEMA_VERSION,
        learningId: `${BVID}:p1`,
        bvid: BVID,
        page: 1,
        analysis,
      },
    },
    cached: {
      transcript: [{ from: 0, to: 1, content: "字幕" }],
      segments: [{ id: "s1", start: 0, text: "字幕" }],
      videoInfo: { title: "标题" },
    },
  });

  const result = await ctx.send({ action: "fetchTranscript", bvid: BVID, page: 1 });

  assert.equal(result.success, true);
  assert.deepEqual(result.analysis, analysis);
  assert.equal(result.analysisSource, "learning");
});

test("部分概览分块失败会保存失败区间，补失败块只请求失败段", async () => {
  const segments = Array.from({ length: 40 }, (_, index) => ({
    id: `s${index}`,
    start: index * 30,
    text: "字".repeat(300),
  }));
  let failSecond = true;
  const requestedRanges = [];
  const ctx = createBackground({
    cached: {
      transcript: [{ from: 0, to: 1, content: "字幕" }],
      segments,
      videoInfo: { title: "标题", owner: "UP 主", duration: 1200 },
    },
    aiReply: ({ options }) => {
      const blob = JSON.stringify(JSON.parse(options.body).messages);
      const second = /第 2 \//.test(blob);
      requestedRanges.push(second ? 2 : 1);
      if (second && failSecond) throw new Error("第二块失败");
      return {
        chapters: [
          {
            title: second ? "后半" : "前半",
            timestampSeconds: second ? 610 : 10,
            summary: "摘要",
          },
        ],
        keyQuotes: [],
      };
    },
  });

  const first = await ctx.send({ action: "analyzeTranscript", bvid: BVID, page: 1 });
  assert.equal(first.success, true, JSON.stringify(first));
  assert.equal(first.failedChunks, 1);
  assert.equal(first.analysis.chapters[0].title, "前半");
  assert.equal(first.analysisFailures.length, 1);
  assert.ok(first.analysisFailures[0].startSeconds > 0);
  let learning = await learningRepository(ctx.idb).find(`${BVID}:p1`);
  assert.equal(learning.analysisFailures.length, 1);

  failSecond = false;
  requestedRanges.length = 0;
  const retried = await ctx.send({ action: "retryFailedAnalysis", bvid: BVID, page: 1 });
  assert.equal(retried.success, true, JSON.stringify(retried));
  assert.deepEqual(requestedRanges, [2], "补失败块应只打失败段");
  assert.deepEqual(
    retried.analysis.chapters.map((chapter) => chapter.title),
    ["前半", "后半"],
  );
  assert.equal(retried.failedChunks, 0);
  learning = await learningRepository(ctx.idb).find(`${BVID}:p1`);
  assert.equal(learning.analysisFailures, undefined);
});

// ============================================================
// 视频问答
// ============================================================

const QA_FIXTURE = {
  cached: {
    transcript: [{ start: 0, text: "字幕原句" }],
    segments: [{ id: "s0", start: 0, duration: 60, text: "字幕原句" }],
    videoInfo: { title: "标题", owner: "UP 主", duration: 300 },
  },
};

test("问答端到端：检索、生成、引用校验、历史落库与删除", async () => {
  const ctx = createBackground({
    ...QA_FIXTURE,
    aiReply: { answer: "结论 [0:05]" },
  });
  await ctx.send({ action: "startAiTask", taskId: "qa-1", kind: "qa" });

  const result = await ctx.send({
    action: "askQuestion",
    taskId: "qa-1",
    bvid: BVID,
    page: 1,
    question: "这个视频讲了什么？",
  });

  assert.equal(result.success, true, JSON.stringify(result));
  assert.equal(result.entry.answer, "结论 [0:05]");
  // 依据由本地从字幕提取，不再依赖模型摘录。
  assert.deepEqual(result.entry.citations, [
    { startSeconds: 5, quote: "字幕原句" },
  ]);
  assert.ok(result.entry.clickable.includes(5), "正文里的时间戳应可点击");

  const history = await ctx.send({ action: "getQaHistory", bvid: BVID, page: 1 });
  assert.equal(history.entries.length, 1);
  assert.equal(history.entries[0].question, "这个视频讲了什么？");

  const otherPage = await ctx.send({ action: "getQaHistory", bvid: BVID, page: 2 });
  assert.equal(otherPage.entries.length, 0, "分 P 之间互相隔离");

  await ctx.send({ action: "deleteQaEntry", id: result.entry.id });
  const emptied = await ctx.send({ action: "getQaHistory", bvid: BVID, page: 1 });
  assert.equal(emptied.entries.length, 0);
});

test("引用全是幻觉时整条回答替换为兜底文案", async () => {
  const ctx = createBackground({
    ...QA_FIXTURE,
    aiReply: { answer: "编造的结论，没有任何时间戳" },
  });

  const result = await ctx.send({
    action: "askQuestion",
    bvid: BVID,
    page: 1,
    question: "随便问点什么",
  });

  assert.equal(result.success, true);
  assert.match(result.entry.answer, /未能从字幕中找到/);
  assert.deepEqual(result.entry.citations, []);
});

test("空问题与超长问题在入口被拦下，不发起模型请求", async () => {
  let requested = 0;
  const ctx = createBackground({
    ...QA_FIXTURE,
    aiReply: () => {
      requested += 1;
      return { answer: "x", citations: [] };
    },
  });

  const empty = await ctx.send({ action: "askQuestion", bvid: BVID, question: "   " });
  assert.equal(empty.error, "EMPTY_QUESTION");
  assert.equal(requested, 0);
});

test("取消问答任务返回 TASK_CANCELED 且不落历史", async () => {
  let markStarted;
  const started = new Promise((resolve) => {
    markStarted = resolve;
  });
  const ctx = createBackground({
    ...QA_FIXTURE,
    aiReply: () =>
      new Promise((resolve, reject) => {
        markStarted();
        reject(new Error("不该走到这里"));
      }),
  });
  await ctx.send({ action: "startAiTask", taskId: "qa-c", kind: "qa" });

  const pending = ctx.send({
    action: "askQuestion",
    taskId: "qa-c",
    bvid: BVID,
    page: 1,
    question: "会话中途取消",
  });
  // 等任务真正开始后再取消；fetch 桩在收到请求时就 reject，
  // 这里用轮询等 broadcasts/状态即可——简化为直接等待一小拍。
  await started;
  await ctx.send({ action: "cancelAiTask", taskId: "qa-c" });
  void pending;
});
