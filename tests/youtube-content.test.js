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

  const requestTranscript = (forceRefresh = false) => new Promise((resolve) => {
    contentListener(
      { action: "getYoutubeTranscript", forceRefresh },
      {},
      resolve,
    );
  });

  await requestTranscript();
  assert.equal(sent[0].playerResponse.videoDetails.videoId, "dQw4w9WgXcQ");

  location.href = "https://www.youtube.com/watch?v=9bZkp7q19f0";
  currentResponse = {
    videoDetails: { videoId: "9bZkp7q19f0", title: "第二条" },
    captions: { playerCaptionsTracklistRenderer: { captionTracks: [] } },
  };
  await requestTranscript(true);

  assert.equal(sent[1].videoId, "9bZkp7q19f0");
  assert.equal(sent[1].playerResponse.videoDetails.videoId, "9bZkp7q19f0");
  assert.equal(sent[1].forceRefresh, true, "强制刷新参数不能在内容脚本里丢失");
});
