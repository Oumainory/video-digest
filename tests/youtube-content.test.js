const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..");
const PAGE_SOURCE = fs.readFileSync(path.join(ROOT, "youtube-page.js"), "utf8");
const CONTENT_SOURCE = fs.readFileSync(path.join(ROOT, "youtube-content.js"), "utf8");

function createSharedDocument(getPlayerResponse) {
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
      if (id === "movie_player") return { getPlayerResponse };
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
    fetch: async () => ({ ok: true }),
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
  const pageContext = { console, URL, location, document, CustomEvent };
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
  assert.equal(fetches[0].url, trackUrl, "页面重试应先请求原始 XML 地址");
  assert.equal(fetches[0].options.credentials, "include");
  assert.equal(messages[1].pageCaptionFetchAttempted, true);
  assert.match(messages[1].pageCaptionBody, /页面字幕/);
  assert.equal(messages[1].pageCaptionContentType, "text/xml");
});
