const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..");
const PAGE_SOURCE = fs.readFileSync(path.join(ROOT, "youtube-page.js"), "utf8");
const CONTENT_SOURCE = fs.readFileSync(path.join(ROOT, "youtube-content.js"), "utf8");

function createSharedDocument(
  getPlayerResponse,
  getCaptionTrack = () => null,
  setCaptionOption = () => {},
) {
  const listeners = new Map();
  return {
    readyState: "complete",
    title: "测试视频 - YouTube",
    scripts: [],
    addEventListener(type, listener) {
      (listeners.get(type) || listeners.set(type, []).get(type)).push(listener);
    },
    dispatchEvent(event) {
      for (const listener of listeners.get(event.type) || []) listener(event);
      return true;
    },
    getElementById(id) {
      if (id === "movie_player") {
        return {
          getPlayerResponse,
          getOption: getCaptionTrack,
          setOption: setCaptionOption,
        };
      }
      return null;
    },
    querySelector() { return null; },
    createElement() {
      return {
        style: {},
        addEventListener() {},
        prepend() {},
      };
    },
  };
}

function CustomEvent(type, options = {}) {
  this.type = type;
  this.detail = options.detail;
}

function FakeXMLHttpRequest() {}
FakeXMLHttpRequest.prototype.open = function open(method, url) {
  this.method = method;
  this.url = url;
};

test("YouTube 页面桥接在单页切换后返回当前视频的播放器响应", async () => {
  const location = { href: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" };
  let currentResponse = {
    videoDetails: { videoId: "dQw4w9WgXcQ", title: "第一条" },
    captions: { playerCaptionsTracklistRenderer: { captionTracks: [] } },
  };
  const document = createSharedDocument(() => currentResponse);
  const pageContext = {
    console,
    URL,
    location,
    document,
    CustomEvent,
    XMLHttpRequest: FakeXMLHttpRequest,
    fetch: async () => ({
      ok: true,
      headers: { get: () => "application/json" },
      clone: () => ({ text: async () => JSON.stringify({ events: [{ tStartMs: 0, segs: [{ utf8: "播放器字幕" }] }] }) }),
    }),
  };
  pageContext.window = pageContext;
  vm.createContext(pageContext);
  vm.runInContext(PAGE_SOURCE, pageContext);

  let contentListener;
  const sent = [];
  const contentContext = {
    console,
    URL,
    location,
    document,
    CustomEvent,
    setTimeout,
    setInterval() { return 1; },
    chrome: {
      runtime: {
        async sendMessage(message) {
          sent.push(message);
          return { success: true };
        },
        onMessage: {
          addListener(listener) { contentListener = listener; },
        },
      },
    },
  };
  contentContext.globalThis = contentContext;
  vm.createContext(contentContext);
  vm.runInContext(CONTENT_SOURCE, contentContext);

  const xhr = new pageContext.XMLHttpRequest();
  xhr.open(
    "GET",
    "https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ&lang=en&kind=asr",
  );
  await pageContext.fetch(
    "https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ&lang=en&tlang=zh-Hans",
  );
  await new Promise((resolve) => setTimeout(resolve, 0));

  const requestTranscript = (forceRefresh = false) => new Promise((resolve) => {
    contentListener(
      { action: "getYoutubeTranscript", forceRefresh },
      {},
      resolve,
    );
  });

  await requestTranscript();
  assert.equal(sent[0].playerResponse.videoDetails.videoId, "dQw4w9WgXcQ");
  assert.equal(sent[0].captionTrackUrls.length, 2);
  assert.match(sent[0].captionTrackUrls[1], /tlang=zh-Hans/);
  assert.equal(sent[0].captionBodies.length, 1);
  assert.match(sent[0].captionBodies[0].body, /播放器字幕/);
  assert.match(sent[0].captionTrackUrl, /v=dQw4w9WgXcQ/);
  assert.equal(sent[0].pageInfo.title, "测试视频");

  location.href = "https://www.youtube.com/watch?v=9bZkp7q19f0";
  currentResponse = {
    videoDetails: { videoId: "9bZkp7q19f0", title: "第二条" },
    captions: { playerCaptionsTracklistRenderer: { captionTracks: [] } },
  };
  await requestTranscript(true);

  assert.equal(sent[1].videoId, "9bZkp7q19f0");
  assert.equal(sent[1].playerResponse.videoDetails.videoId, "9bZkp7q19f0");
  assert.equal(sent[1].captionTrackUrl, "", "不能把上一个视频捕获的字幕地址带过来");
  assert.equal(sent[1].forceRefresh, true, "强制刷新参数不能在内容脚本里丢失");
});

test("YouTube 优先用播放器当前字幕轨在页面会话读取正文", async () => {
  const id = "dQw4w9WgXcQ";
  const trackUrl = `https://www.youtube.com/api/timedtext?v=${id}&lang=zh-Hans&caps=asr`;
  const sessionTrackUrl = `${trackUrl}&pot=test-session`;
  const location = { href: `https://www.youtube.com/watch?v=${id}` };
  const response = {
    videoDetails: { videoId: id, title: "当前字幕轨" },
    captions: {
      playerCaptionsTracklistRenderer: {
        captionTracks: [{ languageCode: "zh-Hans", kind: "asr", vssId: ".zh-Hans", baseUrl: trackUrl }],
      },
    },
  };
  const document = createSharedDocument(
    () => response,
    () => ({ languageCode: "zh-Hans", kind: "asr", vssId: ".zh-Hans" }),
  );
  const pageContext = {
    console,
    URL,
    location,
    document,
    CustomEvent,
    fetch: async () => ({
      ok: true,
      headers: { get: () => "application/json" },
      text: async () => JSON.stringify({
        events: [
          { tStartMs: 1000, dDurationMs: 1000, segs: [{ utf8: "绝区零玩家到底有多压抑？" }] },
          { tStartMs: 3000, dDurationMs: 1000, segs: [{ utf8: "这两天原神至冬新地图火了" }] },
          { tStartMs: 5000, dDurationMs: 1000, segs: [{ utf8: "火的原因不是地图有多美多好" }] },
        ],
      }),
    }),
  };
  pageContext.window = pageContext;
  vm.createContext(pageContext);
  vm.runInContext(PAGE_SOURCE, pageContext);
  await pageContext.fetch(sessionTrackUrl);

  let contentListener;
  let sent;
  const contentContext = {
    console,
    URL,
    location,
    document,
    CustomEvent,
    setTimeout,
    setInterval() { return 1; },
    chrome: {
      runtime: {
        async sendMessage(message) { sent = message; return { success: true }; },
        onMessage: { addListener(listener) { contentListener = listener; } },
      },
    },
  };
  contentContext.globalThis = contentContext;
  vm.createContext(contentContext);
  vm.runInContext(CONTENT_SOURCE, contentContext);

  await new Promise((resolve) => {
    contentListener({ action: "getYoutubeTranscript" }, {}, resolve);
  });

  assert.equal(sent.activeCaptionTrack.kind, "asr");
  assert.equal(sent.pageCaptionTrackUrl, sessionTrackUrl);
  assert.match(sent.pageCaptionBody, /绝区零玩家到底有多压抑/);
  assert.match(sent.pageCaptionBody, /火的原因不是地图有多美多好/);
});

test("没有现成 timedtext 请求时，先让播放器重载当前 CC 轨再获取完整正文", async () => {
  const id = "dQw4w9WgXcQ";
  const staticTrackUrl = `https://www.youtube.com/api/timedtext?v=${id}&lang=zh-Hans&caps=asr`;
  const sessionTrackUrl = `${staticTrackUrl}&pot=reload-session`;
  const location = { href: `https://www.youtube.com/watch?v=${id}` };
  const response = {
    videoDetails: { videoId: id, title: "重载字幕轨" },
    captions: {
      playerCaptionsTracklistRenderer: {
        captionTracks: [{
          languageCode: "zh-Hans",
          kind: "asr",
          vssId: ".zh-Hans",
          baseUrl: staticTrackUrl,
        }],
      },
    },
  };
  let pageContext;
  let reloads = 0;
  const document = createSharedDocument(
    () => response,
    () => ({ languageCode: "zh-Hans", kind: "asr", vssId: ".zh-Hans" }),
    () => {
      reloads += 1;
      void pageContext.fetch(sessionTrackUrl);
    },
  );
  pageContext = {
    console,
    URL,
    location,
    document,
    CustomEvent,
    setTimeout,
    fetch: async () => ({
      ok: true,
      headers: { get: () => "application/json" },
      text: async () => JSON.stringify({
        events: [
          { tStartMs: 1000, dDurationMs: 1000, segs: [{ utf8: "绝区零玩家到底有多压抑？" }] },
          { tStartMs: 3000, dDurationMs: 1000, segs: [{ utf8: "这两天原神至冬新地图火了" }] },
          { tStartMs: 5000, dDurationMs: 1000, segs: [{ utf8: "火的原因不是地图有多美多好" }] },
        ],
      }),
    }),
  };
  pageContext.window = pageContext;
  vm.createContext(pageContext);
  vm.runInContext(PAGE_SOURCE, pageContext);

  let contentListener;
  let sent;
  const contentContext = {
    console,
    URL,
    location,
    document,
    CustomEvent,
    setTimeout,
    setInterval() { return 1; },
    chrome: {
      runtime: {
        async sendMessage(message) { sent = message; return { success: true }; },
        onMessage: { addListener(listener) { contentListener = listener; } },
      },
    },
  };
  contentContext.globalThis = contentContext;
  vm.createContext(contentContext);
  vm.runInContext(CONTENT_SOURCE, contentContext);

  await new Promise((resolve) => {
    contentListener({ action: "getYoutubeTranscript" }, {}, resolve);
  });

  assert.equal(reloads, 1);
  assert.equal(sent.pageCaptionTrackUrl, sessionTrackUrl);
  assert.match(sent.pageCaptionBody, /绝区零玩家到底有多压抑/);
  assert.match(sent.pageCaptionBody, /这两天原神至冬新地图火了/);
  assert.match(sent.pageCaptionBody, /火的原因不是地图有多美多好/);
});

test("播放器没有字幕轨时从当前 watch HTML 恢复响应", async () => {
  const id = "dQw4w9WgXcQ";
  const location = { href: `https://www.youtube.com/watch?v=${id}` };
  const document = createSharedDocument(() => null);
  let contentListener;
  let sent;
  const pageContext = {
    console,
    URL,
    location,
    document,
    CustomEvent,
    setTimeout,
  };
  pageContext.window = pageContext;
  vm.createContext(pageContext);
  vm.runInContext(PAGE_SOURCE, pageContext);

  const recovered = {
    videoDetails: { videoId: id, title: "HTML 里的视频" },
    captions: {
      playerCaptionsTracklistRenderer: {
        captionTracks: [{ languageCode: "en", baseUrl: "https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ&lang=en" }],
      },
    },
  };
  const contentContext = {
    console,
    URL,
    location,
    document,
    CustomEvent,
    setTimeout(resolve) { resolve(); return 1; },
    setInterval() { return 1; },
    fetch: async () => ({
      ok: true,
      text: async () => `<script>var ytInitialPlayerResponse = ${JSON.stringify(recovered)};</script>`,
    }),
    chrome: {
      runtime: {
        async sendMessage(message) { sent = message; return { success: true }; },
        onMessage: { addListener(listener) { contentListener = listener; } },
      },
    },
  };
  contentContext.globalThis = contentContext;
  vm.createContext(contentContext);
  vm.runInContext(CONTENT_SOURCE, contentContext);

  await new Promise((resolve) => {
    contentListener({ action: "getYoutubeTranscript" }, {}, resolve);
  });
  assert.equal(sent.playerResponse.videoDetails.videoId, id);
  assert.equal(
    sent.playerResponse.captions.playerCaptionsTracklistRenderer.captionTracks.length,
    1,
  );
});

test("后台字幕为空时使用当前 YouTube 页面会话重试", async () => {
  const id = "dQw4w9WgXcQ";
  const trackUrl = `https://www.youtube.com/api/timedtext?v=${id}&lang=en`;
  const location = { href: `https://www.youtube.com/watch?v=${id}` };
  const response = {
    videoDetails: { videoId: id, title: "需要页面会话" },
    captions: {
      playerCaptionsTracklistRenderer: {
        captionTracks: [{ languageCode: "en", baseUrl: trackUrl }],
      },
    },
  };
  const document = createSharedDocument(() => response);
  let contentListener;
  const messages = [];
  const fetches = [];
  const pageContext = { console, URL, location, document, CustomEvent, setTimeout };
  pageContext.window = pageContext;
  vm.createContext(pageContext);
  vm.runInContext(PAGE_SOURCE, pageContext);

  const contentContext = {
    console,
    URL,
    location,
    document,
    CustomEvent,
    setTimeout,
    setInterval() { return 1; },
    fetch: async (url, options) => {
      fetches.push({ url, options });
      return {
        ok: true,
        headers: { get: () => "text/xml" },
        text: async () => '<transcript><text start="1" dur="2">页面字幕</text></transcript>',
      };
    },
    chrome: {
      runtime: {
        async sendMessage(message) {
          messages.push(message);
          if (messages.length === 1) {
            return {
              success: false,
              error: "EMPTY_TRANSCRIPT",
              needsPageCaptionFetch: true,
              pageCaptionTrackUrl: trackUrl,
            };
          }
          return { success: true, transcript: [{ text: "页面字幕" }] };
        },
        onMessage: { addListener(listener) { contentListener = listener; } },
      },
    },
  };
  contentContext.globalThis = contentContext;
  vm.createContext(contentContext);
  vm.runInContext(CONTENT_SOURCE, contentContext);

  const result = await new Promise((resolve) => {
    contentListener({ action: "getYoutubeTranscript" }, {}, resolve);
  });
  assert.equal(result.success, true);
  assert.equal(fetches[0].url, `${trackUrl}&fmt=json3`, "页面重试应优先请求 JSON3");
  assert.equal(fetches[0].options.credentials, "include");
  assert.equal(messages[1].pageCaptionFetchAttempted, true);
  assert.match(messages[1].pageCaptionBody, /页面字幕/);
  assert.equal(messages[1].pageCaptionContentType, "text/xml");
});

test("页面世界按 Monica 的方式用播放器会话请求 timedtext 正文", async () => {
  const id = "dQw4w9WgXcQ";
  const trackUrl = `https://www.youtube.com/api/timedtext?v=${id}&lang=en&expire=999`;
  const location = { href: `https://www.youtube.com/watch?v=${id}` };
  const response = {
    videoDetails: { videoId: id, title: "页面会话字幕" },
    captions: {
      playerCaptionsTracklistRenderer: {
        captionTracks: [{ languageCode: "en", baseUrl: trackUrl }],
      },
    },
  };
  const document = createSharedDocument(() => response);
  let contentListener;
  const messages = [];
  const pageFetches = [];
  const pageContext = {
    console,
    URL,
    location,
    document,
    CustomEvent,
    setTimeout,
    fetch: async (url, options) => {
      pageFetches.push({ url, options });
      return {
        ok: true,
        headers: { get: () => "text/xml" },
        text: async () => '<transcript><text start="3" dur="2">播放器当前字幕</text></transcript>',
        clone: () => ({ text: async () => '<transcript><text start="3" dur="2">播放器当前字幕</text></transcript>' }),
      };
    },
  };
  pageContext.window = pageContext;
  vm.createContext(pageContext);
  vm.runInContext(PAGE_SOURCE, pageContext);

  const contentContext = {
    console,
    URL,
    location,
    document,
    CustomEvent,
    setTimeout,
    setInterval() { return 1; },
    fetch: async () => {
      throw new Error("页面世界成功时不应再走 isolated world");
    },
    chrome: {
      runtime: {
        async sendMessage(message) {
          messages.push(message);
          if (messages.length === 1) {
            return {
              success: false,
              error: "EMPTY_TRANSCRIPT",
              needsPageCaptionFetch: true,
              pageCaptionTrackUrl: trackUrl,
            };
          }
          return { success: true, transcript: [{ text: "播放器当前字幕" }] };
        },
        onMessage: { addListener(listener) { contentListener = listener; } },
      },
    },
  };
  contentContext.globalThis = contentContext;
  vm.createContext(contentContext);
  vm.runInContext(CONTENT_SOURCE, contentContext);

  const result = await new Promise((resolve) => {
    contentListener({ action: "getYoutubeTranscript" }, {}, resolve);
  });

  assert.equal(result.success, true, JSON.stringify({ result, pageFetches, messages }));
  assert.equal(pageFetches[0].url, `${trackUrl}&fmt=json3`);
  assert.equal(pageFetches[0].options.credentials, "include");
  assert.equal(messages.length, 2);
  assert.match(messages[1].pageCaptionBody, /播放器当前字幕/);
});
