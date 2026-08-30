const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { Readable } = require("node:stream");
const { ModelStore } = require("../companion/model-store.cjs");

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function u16(value) {
  const buffer = Buffer.alloc(2);
  buffer.writeUInt16LE(value & 0xffff, 0);
  return buffer;
}

function u32(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(value >>> 0, 0);
  return buffer;
}

function makeZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const content = Buffer.from(entry.data);
    const crc = crc32(content);
    const local = Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x03, 0x04]),
      u16(20), u16(0), u16(0), u16(0), u16(0),
      u32(crc), u32(content.length), u32(content.length),
      u16(name.length), u16(0),
      name, content,
    ]);
    locals.push(local);
    centrals.push(Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x01, 0x02]),
      u16(20), u16(20), u16(0), u16(0), u16(0), u16(0),
      u32(crc), u32(content.length), u32(content.length),
      u16(name.length), u16(0), u16(0), u16(0), u16(0),
      u32(0), u32(offset),
      name,
    ]));
    offset += local.length;
  }
  const centralDirectory = Buffer.concat(centrals);
  const end = Buffer.concat([
    Buffer.from([0x50, 0x4b, 0x05, 0x06]),
    u16(0), u16(0), u16(entries.length), u16(entries.length),
    u32(centralDirectory.length), u32(offset), u16(0),
  ]);
  return Buffer.concat([...locals, centralDirectory, end]);
}

test("模型清单支持按需下载、安装状态和按模式解析路径", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "video-digest-models-"));
  const sourceFile = path.join(root, "model-sources.json");
  const stateFile = path.join(root, "model-state.json");
  fs.writeFileSync(sourceFile, JSON.stringify({
    "whisper-multilingual": {
      url: "https://models.example.test/whisper.bin",
      fileName: "whisper.bin",
      sizeBytes: 5,
    },
  }));
  const previousFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    status: 200,
    headers: new Map([["content-length", "5"]]),
    body: Readable.from([Buffer.from("asr!!")]),
  });
  try {
    const store = new ModelStore({ root: path.join(root, "models"), stateFile, sourceFiles: [sourceFile] });
    const before = await store.list();
    assert.equal(before.every((model) => model.sourceConfigured), true);
    assert.equal(before.every((model) => !model.installed), true);

    const progress = [];
    const installed = await store.download("whisper-multilingual", (value) => progress.push(value));
    assert.equal(installed.installed, true);
    assert.equal(fs.readFileSync(path.join(root, "models", "whisper-multilingual", "whisper.bin"), "utf8"), "asr!!");
    assert.equal(progress.at(-1).done, 5);
    assert.deepEqual(await store.pathsForMode("asr"), {
      asr: path.join(root, "models", "whisper-multilingual", "whisper.bin"),
    });
    assert.deepEqual(await store.pathsForMode("both"), {
      asr: path.join(root, "models", "whisper-multilingual", "whisper.bin"),
    });

    await store.uninstall("whisper-multilingual");
    assert.equal((await store.list()).find((model) => model.id === "whisper-multilingual").installed, false);
  } finally {
    global.fetch = previousFetch;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("模型下载源只接受 HTTPS，未配置时不会伪装成可下载", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "video-digest-models-"));
  const sourceFile = path.join(root, "model-sources.json");
  fs.writeFileSync(sourceFile, JSON.stringify({
    "whisper-multilingual": { url: "http://example.test/model.bin" },
  }));
  try {
    const store = new ModelStore({ root: path.join(root, "models"), stateFile: path.join(root, "state.json"), sourceFiles: [sourceFile] });
    const asr = (await store.list()).find((model) => model.kind === "asr");
    assert.equal(asr.sourceConfigured, false);
    await assert.rejects(store.download(asr.id), (error) => error.code === "MODEL_SOURCE_NOT_CONFIGURED");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("下载内容与声明的 SHA-256 不一致时拒绝并清理临时文件", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "video-digest-models-"));
  const models = path.join(root, "models");
  const sourceFile = path.join(root, "model-sources.json");
  const stateFile = path.join(root, "model-state.json");
  fs.writeFileSync(sourceFile, JSON.stringify({
    "whisper-multilingual": {
      url: "https://models.example.test/whisper.bin",
      fileName: "whisper.bin",
      sizeBytes: 5,
      sha256: "a".repeat(64),
    },
  }));
  const previousFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    status: 200,
    headers: new Map([["content-length", "5"]]),
    body: Readable.from([Buffer.from("asr!!")]),
  });
  try {
    const store = new ModelStore({ root: models, stateFile, sourceFiles: [sourceFile] });
    await assert.rejects(store.download("whisper-multilingual"), (error) => error.code === "MODEL_CHECKSUM_MISMATCH");
    assert.deepEqual(fs.readdirSync(models), []);
  } finally {
    global.fetch = previousFetch;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("下载内容与声明的 sizeBytes 不一致时拒绝并清理临时文件", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "video-digest-models-"));
  const models = path.join(root, "models");
  const sourceFile = path.join(root, "model-sources.json");
  const stateFile = path.join(root, "model-state.json");
  fs.writeFileSync(sourceFile, JSON.stringify({
    "whisper-multilingual": {
      url: "https://models.example.test/whisper.bin",
      fileName: "whisper.bin",
      sizeBytes: 99,
    },
  }));
  const previousFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    status: 200,
    headers: new Map([["content-length", "5"]]),
    body: Readable.from([Buffer.from("asr!!")]),
  });
  try {
    const store = new ModelStore({ root: models, stateFile, sourceFiles: [sourceFile] });
    await assert.rejects(store.download("whisper-multilingual"), (error) => error.code === "MODEL_SIZE_MISMATCH");
    assert.deepEqual(fs.readdirSync(models), []);
  } finally {
    global.fetch = previousFetch;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("ZIP 模型包按 entrypoint 安装并返回版本和许可证", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "video-digest-models-"));
  const models = path.join(root, "models");
  const catalog = [
    { id: "ocr-archive-test", kind: "ocr", label: "Test OCR", fileName: "model.bin", backend: "test" },
  ];
  const archive = makeZip([
    { name: "models/inference.pdmodel", data: "paddle-model" },
    { name: "models/config.txt", data: "config" },
  ]);
  const sha256 = crypto.createHash("sha256").update(archive).digest("hex");
  const sourceFile = path.join(root, "model-sources.json");
  const stateFile = path.join(root, "model-state.json");
  fs.writeFileSync(sourceFile, JSON.stringify({
    "ocr-archive-test": {
      url: "https://models.example.test/paddle.zip",
      archive: "paddle.zip",
      entrypoint: "models/inference.pdmodel",
      version: "1.0.0",
      license: "Apache-2.0",
      sha256,
      sizeBytes: archive.length,
    },
  }));
  const previousFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    status: 200,
    headers: new Map([["content-length", String(archive.length)]]),
    body: Readable.from([archive]),
  });
  try {
    const store = new ModelStore({ root: models, stateFile, sourceFiles: [sourceFile], catalog });
    const installed = await store.download("ocr-archive-test");
    assert.equal(installed.installed, true);
    assert.equal(installed.version, "1.0.0");
    assert.equal(installed.license, "Apache-2.0");
    assert.equal(
      fs.readFileSync(path.join(models, "ocr-archive-test", "models", "inference.pdmodel"), "utf8"),
      "paddle-model",
    );
  } finally {
    global.fetch = previousFetch;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
