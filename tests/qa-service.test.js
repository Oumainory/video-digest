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
