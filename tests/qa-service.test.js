const test = require("node:test");
const assert = require("node:assert/strict");

const QA_SERVICE = require("../lib/qa-service.js");
const LEARNING_STORE = require("../lib/learning-store.js");
const IDB = require("../lib/idb.js");
const { createMemoryIndexedDb } = require("./helpers/memory-idb.js");

const TRANSCRIPT_FIXTURE = [{ start: 0, text: "字幕句子" }];
const SEGMENTS_FIXTURE = [{ id: "s0", start: 0, duration: 10, text: "字幕句子" }];

function makeService({ reply, segments = SEGMENTS_FIXTURE } = {}) {
  const idb = createMemoryIndexedDb();
  return QA_SERVICE.createQaService({
    cache: { load: async () => null },
    dataReady: async () => {},
    ensureTranscript: async () => ({
      success: true,
      transcript: TRANSCRIPT_FIXTURE,
      segments,
      videoInfo: { title: "标题", owner: "UP" },
    }),
    learningRepository: () =>
      LEARNING_STORE.createLearningRepository({
        driver: IDB.createObjectStoreDriver({ storeName: "learning", indexedDB: idb }),
      }),
    getSettings: async () => ({}),
    repository: () =>
      QA_SERVICE.createQaRepository({
        driver: IDB.createObjectStoreDriver({ storeName: "qa", indexedDB: idb }),
      }),
    loadPromptSection: async (file, heading, vars) => vars.transcriptText ?? "p",
    requestAiCompletion: async () => ({ text: JSON.stringify(reply) }),
    aiErrorResponse: (error) => ({ success: false, error: error.message }),
  });
}

test("剥掉模型包在回答外面的成对引号", async () => {
  let captured = false;
  const idb = createMemoryIndexedDb();
  const service = QA_SERVICE.createQaService({
    cache: { load: async () => null },
    dataReady: async () => {},
    ensureTranscript: async () => ({
      success: true,
      transcript: TRANSCRIPT_FIXTURE,
      segments: SEGMENTS_FIXTURE,
      videoInfo: { title: "标题", duration: 60 },
    }),
    learningRepository: () =>
      LEARNING_STORE.createLearningRepository({
        driver: IDB.createObjectStoreDriver({ storeName: "learning", indexedDB: idb }),
      }),
    getSettings: async () => ({}),
    repository: () =>
      QA_SERVICE.createQaRepository({
        driver: IDB.createObjectStoreDriver({ storeName: "qa", indexedDB: idb }),
      }),
    loadPromptSection: async (file, heading, vars) => vars.transcriptText ?? "p",
    requestAiCompletion: async () => {
      captured = true;
      return { text: JSON.stringify({ answer: "  “结论 [0:02]。”  " }) };
    },
    aiErrorResponse: (error) => ({ success: false, error: error.message }),
  });

  const result = await service.askQuestion({ bvid: "BV1xx411c7mD", page: 1, question: "问题" });
  assert.equal(result.success, true, JSON.stringify(result));
  assert.equal(result.entry.answer, "结论 [0:02]。", "外层引号应被剥掉");
  assert.deepEqual(result.entry.citations, [
    { startSeconds: 2, quote: "字幕句子" },
  ], "依据由本地从字幕提取");
  assert.ok(captured);
});

test("明确来自视频简介的公司信息可以回答，不被字幕引用兜底覆盖", async () => {
  const service = QA_SERVICE.createQaService({
    cache: { load: async () => null },
    dataReady: async () => {},
    ensureTranscript: async () => ({
      success: true,
      transcript: TRANSCRIPT_FIXTURE,
      segments: SEGMENTS_FIXTURE,
      videoInfo: {
        title: "Nodus Fall - World Premiere Reveal Trailer",
        owner: "IGN",
        description: "Nodus Fall is a brand new game from Hoyoverse.",
      },
    }),
    learningRepository: () => LEARNING_STORE.createLearningRepository({
      driver: IDB.createObjectStoreDriver({ storeName: "learning", indexedDB: createMemoryIndexedDb() }),
    }),
    getSettings: async () => ({}),
    repository: () => QA_SERVICE.createQaRepository({
      driver: IDB.createObjectStoreDriver({ storeName: "qa", indexedDB: createMemoryIndexedDb() }),
    }),
    loadPromptSection: async () => "p",
    requestAiCompletion: async () => ({
      text: JSON.stringify({ answer: "这是 Hoyoverse 的游戏。", evidence: "metadata" }),
    }),
    aiErrorResponse: (error) => ({ success: false, error: error.message }),
  });

  const result = await service.askQuestion({
    bvid: "BV1xx411c7mD",
    question: "这是哪个公司的？",
  });
  assert.equal(result.success, true, JSON.stringify(result));
  assert.equal(result.entry.answer, "这是 Hoyoverse 的游戏。");
  assert.deepEqual(result.entry.citations, []);
});

test("定位字幕模式只返回命中片段，不调用大模型", async () => {
  let requested = false;
  const idb = createMemoryIndexedDb();
  const locator = QA_SERVICE.createQaService({
    cache: { load: async () => null },
    dataReady: async () => {},
    ensureTranscript: async () => ({
      success: true,
      transcript: [{ start: 0, text: "这里讲反向传播" }, { start: 12, text: "最后总结" }],
      segments: [
        { id: "s0", start: 0, duration: 10, text: "这里讲反向传播" },
        { id: "s1", start: 12, duration: 10, text: "最后总结" },
      ],
      videoInfo: { title: "标题", owner: "UP", duration: 30 },
    }),
    learningRepository: () => LEARNING_STORE.createLearningRepository({
      driver: IDB.createObjectStoreDriver({ storeName: "learning", indexedDB: idb }),
    }),
    getSettings: async () => ({}),
    repository: () => QA_SERVICE.createQaRepository({
      driver: IDB.createObjectStoreDriver({ storeName: "qa", indexedDB: idb }),
    }),
    loadPromptSection: async () => "不应调用提示词",
    requestAiCompletion: async () => {
      requested = true;
      throw new Error("定位模式不应调用模型");
    },
    aiErrorResponse: (error) => ({ success: false, error: error.message }),
  });

  const result = await locator.askQuestion({
    bvid: "BV1xx411c7mD",
    question: "反向传播在哪里讲？",
    mode: "locate",
  });
  assert.equal(result.success, true, JSON.stringify(result));
  assert.equal(requested, false);
  assert.equal(result.entry.mode, "locate");
  assert.match(result.entry.answer, /反向传播/);
  assert.deepEqual(result.entry.clickable, [0, 12]);
});

test("同一视频的大模型回答按原顺序成为后续上下文，定位结果不混入", async () => {
  const idb = createMemoryIndexedDb();
  const requests = [];
  let answerIndex = 0;
  const service = QA_SERVICE.createQaService({
    cache: { load: async () => null },
    dataReady: async () => {},
    ensureTranscript: async () => ({
      success: true,
      transcript: [{ start: 0, text: "字幕句子" }],
      segments: SEGMENTS_FIXTURE,
      videoInfo: {
        title: "标题",
        owner: "UP",
        description: "问答需要知道的视频简介",
        duration: 30,
      },
    }),
    learningRepository: () => LEARNING_STORE.createLearningRepository({
      driver: IDB.createObjectStoreDriver({ storeName: "learning", indexedDB: idb }),
    }),
    getSettings: async () => ({}),
    repository: () => QA_SERVICE.createQaRepository({
      driver: IDB.createObjectStoreDriver({ storeName: "qa", indexedDB: idb }),
    }),
    loadPromptSection: async (file, heading, vars) =>
      heading === "系统提示词"
        ? "系统"
        : `标题=${vars.videoTitle};简介=${vars.videoDescription};问题=${vars.question};字幕=${vars.transcriptText}`,
    requestAiCompletion: async ({ messages }) => {
      requests.push(messages);
      answerIndex += 1;
      return { text: JSON.stringify({ answer: `回答${answerIndex} [0:00]` }) };
    },
    aiErrorResponse: (error) => ({ success: false, error: error.message }),
  });

  await service.askQuestion({ bvid: "BV1xx411c7mD", question: "第一问" });
  await service.askQuestion({
    bvid: "BV1xx411c7mD",
    question: "字幕句子在哪里？",
    mode: "locate",
  });
  await service.askQuestion({ bvid: "BV1xx411c7mD", question: "第二问" });

  assert.equal(requests.length, 2, "定位模式不调用模型");
  assert.deepEqual(
    requests[1].map((message) => message.role),
    ["system", "user", "assistant", "user"],
  );
  assert.match(requests[1][1].content, /第一问/);
  assert.match(requests[1][2].content, /回答1/);
  assert.match(requests[0][1].content, /标题=标题/);
  assert.match(requests[0][1].content, /简介=问答需要知道的视频简介/);
  assert.match(requests[1][3].content, /简介=问答需要知道的视频简介/);
  assert.equal(requests[1][2].cacheControl, true, "最后一轮历史是缓存断点");
  assert.doesNotMatch(
    requests[1].map((message) => message.content).join("\n"),
    /在哪里/,
    "本地定位结果不能污染模型对话",
  );

  const history = await service.getQaHistory("BV1xx411c7mD", 1);
  assert.equal("llmUserPrompt" in history.entries[0], false, "内部提示词不发给界面");
});
