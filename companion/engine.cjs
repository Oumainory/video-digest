/**
 * 本地识别引擎适配器。
 *
 * 发行包把 whisper.cpp / OCR 引擎和模型放在 resources/engine 下；引擎进程
 * 通过 JSON Lines 输出 progress/result 事件。本文件不绑定某个供应商，后续换
 * 引擎只需要替换发行包里的 engine/manifest.json 和可执行文件。
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

function loadProtocol() {
  const candidates = [
    path.join(__dirname, "..", "lib", "companion-protocol.js"),
    path.join(__dirname, "lib", "companion-protocol.js"),
    process.resourcesPath && path.join(process.resourcesPath, "lib", "companion-protocol.js"),
  ].filter(Boolean);
  for (const file of candidates) {
    try { return require(file); } catch (error) {}
  }
  throw new Error("桌面软件缺少共享通信协议，请重新安装官方版本。");
}

const protocol = loadProtocol();

function engineError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function replaceTemplate(value, configPath, config) {
  return String(value || "")
    .replaceAll("{{configPath}}", configPath)
    .replaceAll("{{filePath}}", config.filePath || "")
    .replaceAll("{{mode}}", config.mode || "both");
}

function readManifest(engineDir) {
  const file = path.join(engineDir, "manifest.json");
  if (!fs.existsSync(file)) return null;
  try {
    const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!manifest?.executable) return null;
    return manifest;
  } catch (error) {
    throw engineError("ENGINE_MANIFEST_INVALID", "识别引擎配置损坏，请重新安装桌面软件。");
  }
}

function createEngine({ engineDir } = {}) {
  const baseDir = engineDir || path.join(__dirname, "engine");

  async function recognize(config, { onProgress = () => {}, signal, controller } = {}) {
    if (!config?.filePath || !fs.existsSync(config.filePath)) {
      throw engineError("MEDIA_NOT_FOUND", "找不到要识别的媒体文件。");
    }
    const manifest = readManifest(baseDir);
    if (!manifest) {
      throw engineError(
        "ENGINE_NOT_INSTALLED",
        "当前桌面软件没有安装本地识别引擎，请安装包含 OCR/ASR 引擎的官方版本。",
      );
    }

    const executable = path.isAbsolute(manifest.executable)
      ? manifest.executable
      : path.join(baseDir, manifest.executable);
    if (!fs.existsSync(executable)) {
      throw engineError(
        "ENGINE_EXECUTABLE_MISSING",
        "本地识别引擎文件缺失，请重新安装桌面识别软件。",
      );
    }

    const taskDir = path.join(baseDir, ".tasks");
    fs.mkdirSync(taskDir, { recursive: true });
    const configPath = path.join(taskDir, `${protocol.createId("config")}.json`);
    fs.writeFileSync(configPath, JSON.stringify({
      filePath: config.filePath,
      mode: config.mode,
      language: config.language || "",
      region: protocol.normalizeRegion(config.region),
      videoWidth: Number(config.videoWidth) || 0,
      videoHeight: Number(config.videoHeight) || 0,
      useGpu: Boolean(config.useGpu),
      sourceId: config.sourceId,
      modelPaths: config.modelPaths || {},
    }), "utf8");
    const args = (Array.isArray(manifest.args) ? manifest.args : ["{{configPath}}"])
      .map((arg) => replaceTemplate(arg, configPath, config));
    const child = spawn(executable, args, {
      cwd: baseDir,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    controller && (controller.child = child);

    // 引擎通过 stdin 接收控制事件。这样暂停不是只改界面文字，而是能把
    // 实际扫描过程也停下来；发行包里的引擎需实现同一份 JSONL 控制约定。
    const sendControl = (action) => {
      if (!child.stdin?.writable) return false;
      try {
        child.stdin.write(`${JSON.stringify({ type: "control", action })}\n`);
        return true;
      } catch (error) {
        return false;
      }
    };
    child.stdin?.on("error", () => {});
    if (controller) {
      controller.pause = () => {
        controller.paused = true;
        return sendControl("pause");
      };
      controller.resume = () => {
        controller.paused = false;
        return sendControl("resume");
      };
      if (controller.paused) sendControl("pause");
    }

    let result = null;
    let stderr = "";
    let buffer = "";
    const parseLine = (line) => {
      if (!line.trim()) return;
      let message;
      try { message = JSON.parse(line); } catch (error) { return; }
      if (message.type === "progress") {
        onProgress({
          done: message.done,
          total: message.total,
          phase: message.phase,
          message: message.message,
        });
      }
      if (message.type === "result" || message.result) result = message.result || message;
    };
    child.stdout.on("data", (chunk) => {
      buffer += String(chunk);
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || "";
      lines.forEach(parseLine);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk).slice(-4000);
    });

    const abort = () => {
      try { child.kill(); } catch (error) {}
    };
    if (signal?.aborted) abort();
    signal?.addEventListener("abort", abort, { once: true });

    try {
      const exitCode = await new Promise((resolve, reject) => {
        child.once("error", (error) => reject(engineError(
          "ENGINE_EXECUTABLE_FAILED",
          error.code === "EACCES"
            ? "本地识别引擎没有执行权限，请重新安装桌面识别软件。"
            : "本地识别引擎无法启动，请重新安装桌面识别软件。",
        )));
        child.once("close", resolve);
      });
      if (buffer) parseLine(buffer);
      if (signal?.aborted || controller?.canceled) {
        throw engineError("TASK_CANCELED", "任务已取消。");
      }
      if (exitCode !== 0) {
        throw engineError("ENGINE_FAILED", stderr.trim() || `识别引擎退出码：${exitCode}`);
      }
      if (!result) throw engineError("ENGINE_EMPTY_RESULT", "识别引擎没有返回字幕结果。");
      return protocol.normalizeTranscript({
        ...result,
        sourceId: config.sourceId,
        title: result.title || config.fileName,
        fileName: config.fileName,
        mode: config.mode,
        region: config.region,
        context: config.context,
      });
    } finally {
      signal?.removeEventListener("abort", abort);
      try { fs.rmSync(configPath, { force: true }); } catch (error) {}
    }
  }

  return { recognize, readManifest: () => readManifest(baseDir) };
}

module.exports = { createEngine, engineError };
