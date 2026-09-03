const test = require("node:test");
const assert = require("node:assert/strict");

const YOUTUBE = require("../lib/youtube-api.js");

test("识别 YouTube 播放页和短链接的视频号", () => {
  assert.equal(YOUTUBE.parseVideoId("https://www.youtube.com/watch?v=dQw4w9WgXcQ"), "dQw4w9WgXcQ");
  assert.equal(YOUTUBE.parseVideoId("https://m.youtube.com/watch?v=dQw4w9WgXcQ"), "dQw4w9WgXcQ");
  assert.equal(YOUTUBE.parseVideoId("https://youtu.be/dQw4w9WgXcQ?t=2"), "dQw4w9WgXcQ");
  assert.equal(YOUTUBE.parseVideoId("dQw4w9WgXcQ"), "dQw4w9WgXcQ");
  assert.equal(YOUTUBE.parseVideoId("https://example.com/watch?v=dQw4w9WgXcQ"), null);
});

test("只从 player response 读取官方字幕轨，并优先人工轨", () => {
  const tracks = YOUTUBE.normalizeCaptionTracks({
    captions: {
      playerCaptionsTracklistRenderer: {
        captionTracks: [
          { languageCode: "en", kind: "asr", baseUrl: "https://www.youtube.com/api/timedtext?a=1" },
          { languageCode: "en", name: { simpleText: "English" }, baseUrl: "https://www.youtube.com/api/timedtext?a=2" },
        ],
      },
    },
  });
  assert.equal(tracks.length, 2);
  assert.equal(YOUTUBE.pickCaptionTrack(tracks, ["en"]).url.includes("a=2"), true);
  assert.equal(tracks[0].isAi, true);
});

test("后台按当前视频号过滤播放器响应里的字幕地址", () => {
  const tracks = YOUTUBE.normalizeCaptionTracks({
    captions: {
      playerCaptionsTracklistRenderer: {
        captionTracks: [
          { languageCode: "en", baseUrl: "https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ&lang=en" },
          { languageCode: "zh", baseUrl: "https://example.com/api/timedtext?v=dQw4w9WgXcQ&lang=zh" },
          { languageCode: "ja", baseUrl: "https://www.youtube.com/api/timedtext?v=9bZkp7q19f0&lang=ja" },
        ],
      },
    },
  }, "dQw4w9WgXcQ");
  assert.deepEqual(tracks.map((track) => track.lang), ["en"]);
});

test("捕获到的 timedtext 地址必须属于当前 YouTube 视频", () => {
  const track = YOUTUBE.captionTrackFromUrl(
    "https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ&lang=en&kind=asr",
    "dQw4w9WgXcQ",
  );
  assert.equal(track.lang, "en");
  assert.equal(track.isAi, true);
  assert.equal(
    YOUTUBE.captionTrackFromUrl(
      "https://www.youtube.com/api/timedtext?v=9bZkp7q19f0&lang=en",
      "dQw4w9WgXcQ",
    ),
    null,
  );
  assert.equal(
    YOUTUBE.captionTrackFromUrl(
      "https://example.com/api/timedtext?v=dQw4w9WgXcQ&lang=en",
      "dQw4w9WgXcQ",
    ),
    null,
  );
});

test("播放器详情缺失时使用页面元信息补齐视频资料", () => {
  const info = YOUTUBE.normalizeVideoInfo(null, "dQw4w9WgXcQ", "", {
    title: "页面标题",
    owner: "频道名",
    duration: 123,
  });
  assert.equal(info.title, "页面标题");
  assert.equal(info.owner, "频道名");
  assert.equal(info.duration, 123);
});

test("解析 YouTube json3 与 XML 字幕正文", () => {
  const json = YOUTUBE.normalizeJson3({
    events: [
      { tStartMs: 0, dDurationMs: 1200, segs: [{ utf8: "Hello " }, { utf8: "world" }] },
      { tStartMs: 1500, segs: [{ utf8: "下一句" }] },
    ],
  });
  assert.deepEqual(json, [
    { text: "Hello world", start: 0, duration: 1.2 },
    { text: "下一句", start: 1.5, duration: 0.01 },
  ]);

  const xml = YOUTUBE.normalizeXml('<transcript><text start="1.5" dur="2">A &amp; B</text></transcript>');
  assert.deepEqual(xml, [{ text: "A & B", start: 1.5, duration: 2 }]);
  assert.deepEqual(
    YOUTUBE.parseCaptionTrackContent(
      '<transcript><text start="3" dur="1.5">页面会话字幕</text></transcript>',
      "text/xml",
    ),
    [{ text: "页面会话字幕", start: 3, duration: 1.5 }],
  );
});

test("字幕下载优先请求 json3，并兼容文本响应", async () => {
  let requested;
  let credentials;
  const entries = await YOUTUBE.fetchCaptionTrackContent(
    "https://www.youtube.com/api/timedtext?v=1",
    {
      fetchImpl: async (url, options) => {
        requested = url;
        credentials = options.credentials;
        return new Response(JSON.stringify({ events: [{ tStartMs: 0, dDurationMs: 1, segs: [{ utf8: "ok" }] }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    },
  );
  assert.match(requested, /fmt=json3/);
  assert.equal(credentials, "include");
  assert.equal(entries[0].text, "ok");
});
