"use strict";

const fs = require("node:fs");

const configFlag = process.argv.indexOf("--config");
const configFile = configFlag >= 0 ? process.argv[configFlag + 1] : "";
const config = JSON.parse(fs.readFileSync(configFile, "utf8"));
let paused = false;
let canceled = false;

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  for (const line of String(chunk).split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const message = JSON.parse(line);
      if (message.action === "pause") paused = true;
      if (message.action === "resume") paused = false;
      if (message.action === "cancel") canceled = true;
    } catch (error) {}
  }
});

function output(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

let step = 0;
const delay = Math.max(20, Number(process.env.VIDEO_DIGEST_FAKE_ENGINE_DELAY_MS) || 120);
const timer = setInterval(() => {
  if (paused || canceled) return;
  step += 1;
  output({ type: "progress", done: step, total: 3, phase: config.mode, message: `测试进度 ${step}/3` });
  if (step < 3) return;
  clearInterval(timer);
  output({
    type: "result",
    result: {
      title: config.fileName || "E2E result",
      tracks: {
        ocr: { language: "zh", segments: [
          { start: 0.2, end: 2.2, text: "第一行画面字幕" },
          { start: 2.4, end: 4.6, text: "第二行画面字幕" },
        ] },
        asr: { language: "en", segments: [
          { start: 0, end: 2.5, text: "Hello from Video Digest" },
        ] },
      },
    },
  });
  setTimeout(() => process.exit(0), 20);
}, delay);
