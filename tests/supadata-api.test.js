const test = require("node:test");
const assert = require("node:assert/strict");

const SUPADATA = require("../lib/supadata-api.js");

test("Supadata 请求固定使用原生字幕模式并正确编码视频地址", () => {
  const url = new URL(SUPADATA.buildTranscriptUrl("dQw4w9WgXcQ", { language: "zh-Hans" }));
  assert.equal(url.origin, "https://api.supadata.ai");
  assert.equal(url.pathname, "/v1/transcript");
  assert.equal(url.searchParams.get("text"), "false");
  assert.equal(url.searchParams.get("lang"), "zh");
  assert.equal(url.searchParams.get("mode"), "native");
  assert.equal(
    url.searchParams.get("url"),
    "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  );
});

test("Supadata 时间戳字幕转换为项目内部格式并保留完整顺序", () => {
  const result = SUPADATA.parseTranscriptResponse({
    lang: "zh",
    availableLangs: ["zh", "en"],
    content: [
      { text: ">> 第一句", offset: 1000, duration: 1200 },
      { text: "第二句", offset: 3000, duration: 800 },
    ],
  });

  assert.deepEqual(result.entries, [
    { text: "第一句", start: 1, duration: 1.2 },
    { text: "第二句", start: 3, duration: 0.8 },
  ]);
  assert.equal(result.language, "zh");
  assert.deepEqual(result.availableLanguages, ["zh", "en"]);
});

test("Supadata 支持长视频异步任务并轮询到完成结果", async () => {
  const requests = [];
  const responseQueue = [
    { status: 202, body: { jobId: "job-1" } },
    { status: 200, body: { status: "active" } },
    {
      status: 200,
      body: {
        status: "completed",
        lang: "en",
        content: [{ text: "completed subtitle", offset: 5000, duration: 1000 }],
      },
    },
  ];
  const result = await SUPADATA.fetchTranscript("dQw4w9WgXcQ", {
    apiKey: "test-key",
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      const next = responseQueue.shift();
      return {
        ok: next.status >= 200 && next.status < 300,
        status: next.status,
        json: async () => next.body,
      };
    },
    pollIntervalMs: 0,
  });

  assert.equal(result.entries[0].text, "completed subtitle");
  assert.equal(requests.length, 3);
  assert.equal(requests[0].options.headers["x-api-key"], "test-key");
  assert.match(requests[1].url, /\/v1\/transcript\/job-1$/);
});

test("Supadata 错误不会泄露密钥并区分密钥、无字幕与限流", async () => {
  for (const [status, code] of [
    [401, "INVALID_SUPADATA_KEY"],
    [404, "NO_TRANSCRIPT"],
    [429, "SUPADATA_RATE_LIMITED"],
  ]) {
    await assert.rejects(
      SUPADATA.fetchTranscript("dQw4w9WgXcQ", {
        apiKey: "secret-key",
        fetchImpl: async () => ({
          ok: false,
          status,
          json: async () => ({ message: "server detail" }),
        }),
      }),
      (error) => {
        assert.equal(error.code, code);
        assert.doesNotMatch(error.message, /secret-key/);
        return true;
      },
    );
  }
});
