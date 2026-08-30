const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createEngine } = require("../companion/engine.cjs");

test("桌面引擎适配器读取 JSONL 进度和双轨结果", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "video-digest-engine-"));
  try {
    const media = path.join(root, "sample.mp4");
    fs.writeFileSync(media, "placeholder");
    fs.writeFileSync(
      path.join(root, "manifest.json"),
      JSON.stringify({
        executable: process.execPath,
        args: [
          "-e",
          "console.log(JSON.stringify({type:'progress',done:1,total:2,phase:'asr',message:'处理中'})); console.log(JSON.stringify({type:'result',result:{tracks:{ocr:{segments:[{start:0,end:1,text:'画面'}]},asr:{segments:[{start:0,end:1.2,text:'语音'}]}}}}));",
        ],
        supportsPause: true,
      }),
      "utf8",
    );

    const progress = [];
    const result = await createEngine({ engineDir: root }).recognize(
      {
        sourceId: "local-engine-test",
        filePath: media,
        fileName: "sample.mp4",
        mode: "both",
      },
      {
        controller: new AbortController(),
        onProgress: (value) => progress.push(value),
      },
    );

    assert.equal(progress[0].done, 1);
    assert.equal(result.tracks.ocr.segments[0].text, "画面");
    assert.equal(result.tracks.asr.segments[0].text, "语音");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("没有发行引擎时返回可行动的错误", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "video-digest-engine-"));
  try {
    const media = path.join(root, "sample.mp4");
    fs.writeFileSync(media, "placeholder");
    await assert.rejects(
      createEngine({ engineDir: root }).recognize({ filePath: media }),
      (error) => error.code === "ENGINE_NOT_INSTALLED",
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
