"use strict";

/*
 * Prepare the external engine and model inputs used by Electron Builder.
 * Recognition binaries and model weights stay outside the source repository;
 * a release is rejected unless all of its inputs are explicit and verifiable.
 */
const fs = require("node:fs");
const path = require("node:path");
const { extensionIds, nsisHooks } = require("./release-config.cjs");

const root = __dirname;
const buildDir = path.join(root, "build");
const engineInput = process.env.VIDEO_DIGEST_ENGINE_DIR;
const modelInput = process.env.VIDEO_DIGEST_MODEL_SOURCES_FILE;
const chromeExtensionId = process.env.VIDEO_DIGEST_CHROME_EXTENSION_ID;
const edgeExtensionId = process.env.VIDEO_DIGEST_EDGE_EXTENSION_ID || chromeExtensionId;

function requireDirectory(value, label) {
  if (!value || !fs.statSync(value, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`${label} 不存在或不是目录。`);
  }
  return path.resolve(value);
}

function requireFile(value, label) {
  if (!value || !fs.statSync(value, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`${label} 不存在或不是文件。`);
  }
  return path.resolve(value);
}

function readJson(file, label) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`${label} 不是有效 JSON：${error.message}`);
  }
}

function validateModelEntry(id, entry) {
  let url;
  try { url = new URL(String(entry?.url || "")); } catch (error) { url = null; }
  if (!url || url.protocol !== "https:" || url.hostname.endsWith(".invalid")) {
    throw new Error(`模型 ${id} 缺少有效的 HTTPS 下载地址。`);
  }
  if (!String(entry?.version || "").trim()) {
    throw new Error(`模型 ${id} 缺少版本号。`);
  }
  if (!/^[a-f0-9]{64}$/i.test(String(entry?.sha256 || ""))) {
    throw new Error(`模型 ${id} 缺少有效的 SHA-256。`);
  }
  if (!Number.isFinite(Number(entry?.sizeBytes)) || Number(entry.sizeBytes) <= 0) {
    throw new Error(`模型 ${id} 缺少有效的 sizeBytes。`);
  }
  if (!String(entry?.license || "").trim()) {
    throw new Error(`模型 ${id} 缺少许可证说明。`);
  }
  if (entry.archive && !String(entry.entrypoint || "").trim()) {
    throw new Error(`压缩模型 ${id} 必须声明 entrypoint。`);
  }
}

function prepareEngine() {
  const source = requireDirectory(engineInput, "VIDEO_DIGEST_ENGINE_DIR");
  const manifestFile = path.join(source, "manifest.json");
  const manifest = readJson(requireFile(manifestFile, "识别引擎 manifest.json"), "识别引擎 manifest.json");
  if (!manifest.executable || !Array.isArray(manifest.args)) {
    throw new Error("识别引擎 manifest.json 必须包含 executable 和 args。");
  }
  const executable = path.isAbsolute(manifest.executable)
    ? manifest.executable
    : path.join(source, manifest.executable);
  requireFile(executable, "识别引擎 executable");

  const destination = path.join(buildDir, "engine");
  fs.rmSync(destination, { recursive: true, force: true });
  fs.cpSync(source, destination, { recursive: true });
  return destination;
}

function prepareModels() {
  const source = requireFile(modelInput, "VIDEO_DIGEST_MODEL_SOURCES_FILE");
  const values = readJson(source, "模型来源清单");
  for (const id of ["whisper-multilingual", "ocr-mobile"]) validateModelEntry(id, values[id]);
  const destination = path.join(buildDir, "model-sources.json");
  fs.writeFileSync(destination, `${JSON.stringify(values, null, 2)}\n`, "utf8");
  return destination;
}

function main() {
  extensionIds({ chrome: chromeExtensionId, edge: edgeExtensionId });
  fs.mkdirSync(buildDir, { recursive: true });
  prepareEngine();
  prepareModels();
  fs.writeFileSync(
    path.join(buildDir, "installer.generated.nsh"),
    nsisHooks({ chromeExtensionId, edgeExtensionId }),
    "utf8",
  );
  console.log("已准备 Windows 发行包输入：engine、model-sources 和 Native Messaging 安装钩子。");
}

try {
  main();
} catch (error) {
  console.error(`发行包准备失败：${error.message}`);
  process.exitCode = 1;
}
