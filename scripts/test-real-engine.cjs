"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { createEngine } = require("../companion/engine.cjs");

const root = path.resolve(__dirname, "..");
const engineDir = process.env.VIDEO_DIGEST_ENGINE_DIR;
const media = process.env.VIDEO_DIGEST_TEST_MEDIA
  || path.join(root, "tests", "fixtures", "engine-acceptance.mp4");
const model = process.env.VIDEO_DIGEST_WHISPER_MODEL;
const expected = JSON.parse(fs.readFileSync(
  path.join(root, "tests", "fixtures", "engine-acceptance.expected.json"),
  "utf8",
));

if (!engineDir || !model) {
  throw new Error("真实引擎验收需要 VIDEO_DIGEST_ENGINE_DIR 和 VIDEO_DIGEST_WHISPER_MODEL。");
}
if (!fs.existsSync(media)) throw new Error(`缺少项目自有测试媒体：${media}`);
if (!fs.existsSync(model)) throw new Error(`缺少 Whisper 模型：${model}`);
const mediaHash = crypto.createHash("sha256").update(fs.readFileSync(media)).digest("hex");
if (mediaHash !== expected.sha256) throw new Error("项目自有测试媒体 SHA-256 与预期文件不一致。");

function normalize(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9\u3400-\u9fff]+/g, " ")
    .trim();
}

function editDistance(left, right) {
  const rows = Array.from({ length: left.length + 1 }, (_, index) => [index]);
  for (let column = 0; column <= right.length; column += 1) rows[0][column] = column;
  for (let row = 1; row <= left.length; row += 1) {
    for (let column = 1; column <= right.length; column += 1) {
      rows[row][column] = Math.min(
        rows[row - 1][column] + 1,
        rows[row][column - 1] + 1,
        rows[row - 1][column - 1] + (left[row - 1] === right[column - 1] ? 0 : 1),
      );
    }
  }
  return rows[left.length][right.length];
}

async function main() {
  const progress = [];
  const controller = new AbortController();
  const result = await createEngine({ engineDir }).recognize({
    sourceId: "release-engine-acceptance",
    filePath: media,
    fileName: path.basename(media),
    mode: "both",
    language: "auto",
    region: { x: 0, y: 0.72, width: 1, height: 0.28 },
    modelPaths: { asr: model },
  }, { controller, signal: controller.signal, onProgress: (value) => progress.push(value) });

  const ocr = result.tracks?.ocr?.segments || [];
  for (const wanted of expected.ocr) {
    const match = ocr.find((entry) => normalize(entry.text).includes(normalize(wanted.text)));
    if (!match) throw new Error(`OCR 未识别预期字幕：${wanted.text}`);
    if (Math.abs(match.start - wanted.start) > expected.limits.ocrStartErrorSeconds) {
      throw new Error(`OCR 时间误差超限：${wanted.text}，实际 ${match.start}s。`);
    }
  }

  const actualWords = normalize((result.tracks?.asr?.segments || []).map((entry) => entry.text).join(" ")).split(/\s+/).filter(Boolean);
  const expectedWords = normalize(expected.asrReference).split(/\s+/).filter(Boolean);
  const wer = editDistance(expectedWords, actualWords) / Math.max(1, expectedWords.length);
  if (wer > expected.limits.asrWordErrorRate) {
    throw new Error(`ASR WER ${(wer * 100).toFixed(1)}% 超过 ${(expected.limits.asrWordErrorRate * 100)}%。`);
  }
  if (!progress.length) throw new Error("真实引擎没有发送进度事件。");
  console.log(`Real engine accepted: ${ocr.length} OCR segments, ASR WER ${(wer * 100).toFixed(1)}%.`);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
