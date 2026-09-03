const test = require("node:test");
const assert = require("node:assert/strict");

const PROTOCOL = require("../lib/companion-protocol.js");
const BRIDGE = require("../lib/companion-bridge.js");
const LOCAL_STORE = require("../lib/local-transcript-store.js");
const IDB = require("../lib/idb.js");
const { createMemoryIndexedDb } = require("./helpers/memory-idb.js");

test("本地字幕框坐标会限制在视频画面内，并支持位置预设", () => {
  assert.deepEqual(PROTOCOL.normalizeRegion({ x: -1, y: 2, width: 2, height: 0 }), {
    x: 0,
    y: 0.99,
    width: 1,
    height: 0.01,
  });
  assert.deepEqual(PROTOCOL.presetRegion("top"), {
    x: 0.05,
    y: 0.06,
    width: 0.9,
    height: 0.18,
  });
});

test("本地识别结果保留 OCR/ASR 两条独立时间轴", () => {
  const result = PROTOCOL.normalizeTranscript({
    sourceId: "local-1",
    fileName: "lesson.mp4",
    mode: "both",
    tracks: {
      asr: { language: "en", segments: [{ start: 2, end: 3, text: "spoken" }] },
      ocr: { language: "zh", segments: [{ from: 0, to: 1.5, content: "画面字幕" }] },
    },
  });

  assert.equal(result.sourceId, "local-1");
  assert.deepEqual(result.tracks.ocr.segments[0], {
    id: "ocr-0-0",
    start: 0,
    end: 1.5,
    text: "画面字幕",
  });
  assert.equal(result.tracks.asr.segments[0].text, "spoken");
  assert.equal(result.duration, 3);
});

test("字幕导出支持 SRT、VTT、ASS，并保留时间顺序", () => {
  const track = {
    kind: "ocr",
    segments: [
      { start: 1.25, end: 2.5, text: "第二句" },
      { start: 0, end: 1, text: "第一句" },
    ],
  };
  const srt = PROTOCOL.serializeSubtitle(track, "srt");
  const vtt = PROTOCOL.serializeSubtitle(track, "vtt");
  const ass = PROTOCOL.serializeSubtitle(track, "ass");
  assert.match(srt, /1\n00:00:00,000 --> 00:00:01,000\n第一句/);
  assert.match(vtt, /^WEBVTT\n/);
  assert.match(vtt, /00:00:01\.250 --> 00:00:02\.500/);
  assert.match(ass, /\[Events\]/);
  assert.match(ass, /Dialogue: 0,0:00:00\.00,0:00:01\.00/);
});

test("本地字幕仓储可保存、读取、按更新时间排序和删除", async () => {
  const indexedDB = createMemoryIndexedDb();
  const repository = LOCAL_STORE.createLocalTranscriptRepository({
    driver: IDB.createObjectStoreDriver({ indexedDB, storeName: "local-transcripts" }),
    now: 100,
  });
  await repository.save({
    sourceId: "older",
    title: "旧结果",
    updatedAt: 100,
    tracks: { asr: { segments: [{ start: 0, end: 1, text: "old" }] } },
  });
  await repository.save({
    sourceId: "newer",
    title: "新结果",
    updatedAt: 200,
    tracks: { ocr: { segments: [{ start: 0, end: 1, text: "new" }] } },
  });
  assert.deepEqual((await repository.all()).map((item) => item.sourceId), ["newer", "older"]);
  assert.equal((await repository.find("newer")).title, "新结果");
  await repository.remove("newer");
  assert.equal(await repository.find("newer"), null);
});

test("Native Messaging 桥接按 requestId 配对响应，并把事件交给扩展", async () => {
  let onMessage;
  let onDisconnect;
  const events = [];
  const port = {
    onMessage: { addListener(listener) { onMessage = listener; } },
    onDisconnect: { addListener(listener) { onDisconnect = listener; } },
    postMessage(message) {
      queueMicrotask(() => onMessage({
        protocol: PROTOCOL.PROTOCOL,
        version: PROTOCOL.VERSION,
        type: "response",
        requestId: message.requestId,
        success: true,
        payload: { ok: true, action: message.action },
      }));
    },
    disconnect() {},
  };
  const bridge = BRIDGE.createCompanionBridge({
    connectNative: () => port,
    onEvent: (event, payload) => events.push({ event, payload }),
  });
  const reply = await bridge.request(PROTOCOL.ACTIONS.STATUS);
  assert.deepEqual(reply, { ok: true, action: "status" });

  onMessage({
    protocol: PROTOCOL.PROTOCOL,
    version: PROTOCOL.VERSION,
    type: "event",
    event: PROTOCOL.EVENTS.TASK_CHANGED,
    payload: { task: { id: "task-1" } },
  });
  assert.deepEqual(events, [{ event: "taskChanged", payload: { task: { id: "task-1" } } }]);
  assert.equal(typeof onDisconnect, "function");
});

test("Native Messaging 桥接会传播服务端错误并忽略无效消息", async () => {
  let onMessage;
  const port = {
    onMessage: { addListener(listener) { onMessage = listener; } },
    onDisconnect: { addListener() {} },
    postMessage(message) {
      onMessage({ unexpected: true });
      queueMicrotask(() => onMessage({
        protocol: PROTOCOL.PROTOCOL,
        version: PROTOCOL.VERSION,
        type: "error",
        requestId: message.requestId,
        success: false,
        error: "ENGINE_FAILED",
        message: "识别引擎失败",
      }));
    },
  };
  const bridge = BRIDGE.createCompanionBridge({ connectNative: () => port });
  await assert.rejects(
    bridge.request(PROTOCOL.ACTIONS.STATUS),
    (error) => error.code === "ENGINE_FAILED" && error.message === "识别引擎失败",
  );
});

test("Native Messaging 桥接覆盖连接失败、发送失败、超时和主动关闭", async () => {
  assert.throws(() => BRIDGE.createCompanionBridge(), /connectNative/);

  const unavailable = BRIDGE.createCompanionBridge({ connectNative: () => ({}) });
  await assert.rejects(unavailable.request("status"), (error) => error.code === "COMPANION_UNAVAILABLE");

  const missing = BRIDGE.createCompanionBridge({ connectNative() { throw new Error("missing"); } });
  await assert.rejects(missing.request("status"), (error) => error.code === "COMPANION_NOT_INSTALLED");

  let disconnect;
  const brokenPort = {
    onMessage: { addListener() {} },
    onDisconnect: { addListener(listener) { disconnect = listener; } },
    postMessage() { throw new Error("send failed"); },
  };
  const broken = BRIDGE.createCompanionBridge({ connectNative: () => brokenPort });
  await assert.rejects(broken.request("status"), (error) => error.code === "COMPANION_SEND_FAILED");

  let posted;
  const timeoutPort = {
    onMessage: { addListener() {} },
    onDisconnect: { addListener() {} },
    postMessage(message) { posted = message; },
    disconnect() {},
  };
  const timed = BRIDGE.createCompanionBridge({ connectNative: () => timeoutPort, timeoutMs: 100 });
  await assert.rejects(timed.request("status"), (error) => error.code === "COMPANION_TIMEOUT");
  assert.ok(posted.requestId);

  const pending = broken.request("status");
  disconnect();
  await assert.rejects(pending, /无法把请求发送/);
  timed.close();
  assert.equal(timed.getPort(), null);
});

test("Native Messaging 桥接断线会拒绝在途请求并在下次请求重连", async () => {
  const ports = [];
  const connectNative = () => {
    let onMessage;
    let onDisconnect;
    const port = {
      onMessage: { addListener(listener) { onMessage = listener; } },
      onDisconnect: { addListener(listener) { onDisconnect = listener; } },
      postMessage(message) { port.lastMessage = message; },
      disconnect() {},
      emit(message) { onMessage(message); },
      drop() { port.error = { message: "pipe closed" }; onDisconnect(); },
    };
    ports.push(port);
    return port;
  };
  const bridge = BRIDGE.createCompanionBridge({ connectNative, timeoutMs: 1000 });
  const first = bridge.request("status");
  await new Promise((resolve) => setImmediate(resolve));
  ports[0].drop();
  await assert.rejects(first, (error) => error.code === "COMPANION_DISCONNECTED");

  const second = bridge.request("status");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(ports.length, 2);
  ports[1].emit({
    protocol: PROTOCOL.PROTOCOL,
    version: PROTOCOL.VERSION,
    type: "response",
    requestId: ports[1].lastMessage.requestId,
    success: true,
    payload: { running: true },
  });
  assert.deepEqual(await second, { running: true });
});
