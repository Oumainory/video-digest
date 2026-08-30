"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { once } = require("node:events");

const execFileAsync = promisify(execFile);

const MODEL_CATALOG = Object.freeze([
  {
    id: "whisper-multilingual",
    kind: "asr",
    label: "Whisper 多语言",
    fileName: "model.bin",
    backend: "whisper.cpp",
  },
]);

function safeFilePart(value, fallback = "model.bin") {
  const clean = String(value || "")
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .replace(/^\.+/, "")
    .slice(0, 180);
  return clean || fallback;
}

function safeRelativePart(value) {
  const normalized = String(value || "").replaceAll("\\", "/");
  if (!normalized || normalized === ".") return "";
  if (normalized.startsWith("/") || /^[a-zA-Z]:\//.test(normalized)) return "";
  const parts = normalized.split("/").filter(Boolean);
  if (parts.some((part) => part === "." || part === ".." || part.includes("\0"))) return "";
  return parts.map((part) => safeFilePart(part, "")).filter(Boolean).join(path.sep);
}

function modelError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function normalizeSha256(value) {
  const result = String(value || "").trim().toLowerCase();
  return /^[a-f0-9]{64}$/.test(result) ? result : "";
}

function isArchiveSource(source) {
  return Boolean(source.archive || source.format === "zip" || source.type === "archive");
}

function archiveNameFor(source, model) {
  const value = typeof source.archive === "string" && source.archive !== "true"
    ? source.archive
    : `${model.id}.zip`;
  return safeFilePart(value, `${model.id}.zip`);
}

function readJsonFile(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

async function hashFile(file) {
  const hash = crypto.createHash("sha256");
  const input = fs.createReadStream(file);
  for await (const chunk of input) hash.update(chunk);
  return hash.digest("hex");
}

function pathInside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function assertSafeExtractedTree(root) {
  if (!fs.existsSync(root)) throw modelError("MODEL_ARCHIVE_INVALID", "模型压缩包没有生成有效目录。");
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (!pathInside(root, target)) throw modelError("MODEL_ARCHIVE_INVALID", "模型压缩包包含越界路径。");
      if (entry.isSymbolicLink()) throw modelError("MODEL_ARCHIVE_INVALID", "模型压缩包不能包含符号链接。");
      if (entry.isDirectory()) visit(target);
    }
  };
  visit(root);
}

async function extractArchive(archive, destination) {
  fs.mkdirSync(destination, { recursive: true });
  try {
    if (process.platform === "win32") {
      const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;
      const command = [
        "$ErrorActionPreference='Stop'",
        `Expand-Archive -LiteralPath ${quote(archive)} -DestinationPath ${quote(destination)} -Force`,
      ].join("; ");
      await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], {
        windowsHide: true,
        maxBuffer: 1024 * 1024 * 4,
      });
    } else {
      await execFileAsync("unzip", ["-q", archive, "-d", destination], { maxBuffer: 1024 * 1024 * 4 });
    }
  } catch (error) {
    throw modelError(
      "MODEL_ARCHIVE_UNSUPPORTED",
      process.platform === "win32"
        ? `模型压缩包解压失败：${error.message || "Expand-Archive 执行失败"}`
        : "当前系统缺少 unzip，无法安装模型压缩包。",
    );
  }
  assertSafeExtractedTree(destination);
}

function randomSuffix() {
  return `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

class ModelStore {
  constructor({ root, stateFile, sourceFiles = [], catalog = MODEL_CATALOG } = {}) {
    this.root = root;
    this.stateFile = stateFile;
    this.sourceFiles = sourceFiles;
    this.catalog = catalog;
  }

  readState() {
    try { return readJsonFile(this.stateFile); } catch (error) { return {}; }
  }

  writeState(state) {
    fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
    const temporary = `${this.stateFile}.${randomSuffix()}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    fs.rmSync(this.stateFile, { force: true });
    fs.renameSync(temporary, this.stateFile);
  }

  readSources() {
    for (const file of this.sourceFiles) {
      try {
        const value = readJsonFile(file);
        if (value && typeof value === "object") return value;
      } catch (error) {
        // A missing or invalid local catalog falls back to the packaged catalog.
      }
    }
    return {};
  }

  sourceFor(model) {
    const source = this.readSources()[model.id] || {};
    let url = "";
    try {
      const parsed = new URL(String(source.url || ""));
      if (parsed.protocol === "https:") url = parsed.toString();
    } catch (error) {
      // Only HTTPS model sources are accepted.
    }
    const archive = isArchiveSource(source);
    const fileName = safeFilePart(source.fileName || model.fileName);
    return {
      url,
      archive,
      archiveName: archiveNameFor(source, model),
      fileName,
      entrypoint: safeRelativePart(source.entrypoint),
      version: String(source.version || "").trim().slice(0, 100),
      sha256: normalizeSha256(source.sha256),
      sizeBytes: Math.max(0, Number(source.sizeBytes) || 0),
      license: String(source.license || "").trim().slice(0, 200),
      licenseUrl: String(source.licenseUrl || "").trim().slice(0, 1000),
    };
  }

  installedPath(model, source) {
    const directory = path.join(this.root, model.id);
    if (!source.archive) return path.join(directory, source.fileName);
    return source.entrypoint ? path.join(directory, source.entrypoint) : directory;
  }

  async list() {
    const state = this.readState();
    return this.catalog.map((model) => {
      const source = this.sourceFor(model);
      const installedPath = this.installedPath(model, source);
      const saved = state[model.id] || {};
      return {
        ...model,
        sizeBytes: source.sizeBytes,
        version: source.version,
        sha256: source.sha256,
        license: source.license,
        licenseUrl: source.licenseUrl,
        archive: source.archive,
        sourceConfigured: Boolean(source.url),
        downloadable: Boolean(source.url),
        installed: Boolean(saved.installed && fs.existsSync(installedPath)),
        installedVersion: String(saved.version || "").trim(),
        downloading: false,
      };
    });
  }

  async writeResponse(response, temporary, source, notify) {
    if (!response.ok || !response.body) {
      throw modelError("MODEL_DOWNLOAD_FAILED", `模型下载失败：HTTP ${response.status}`);
    }
    const file = fs.createWriteStream(temporary);
    const hash = crypto.createHash("sha256");
    let done = 0;
    const total = source.sizeBytes || Number(response.headers.get("content-length")) || 0;
    try {
      for await (const chunk of response.body) {
        const buffer = Buffer.from(chunk);
        hash.update(buffer);
        if (!file.write(buffer)) await once(file, "drain");
        done += buffer.length;
        notify({
          done,
          total,
          phase: "download",
          message: total ? `正在下载 ${Math.round(done / total * 100)}%` : "正在下载模型…",
        });
      }
      await new Promise((resolve, reject) => file.end((error) => error ? reject(error) : resolve()));
    } catch (error) {
      file.destroy();
      throw error;
    }
    if (source.sizeBytes && done !== source.sizeBytes) {
      throw modelError("MODEL_SIZE_MISMATCH", `模型大小校验失败：期望 ${source.sizeBytes} 字节，收到 ${done} 字节。`);
    }
    const actualHash = hash.digest("hex");
    if (source.sha256 && actualHash !== source.sha256) {
      throw modelError("MODEL_CHECKSUM_MISMATCH", "模型 SHA-256 校验失败，文件可能已损坏或来源不正确。");
    }
    return { bytes: done, sha256: actualHash };
  }

  async installDirectory(temporary, model, source) {
    const directory = path.join(this.root, model.id);
    const installing = path.join(this.root, `.${model.id}.${randomSuffix()}.installing`);
    fs.mkdirSync(installing, { recursive: true });
    const target = source.archive ? path.join(installing, source.archiveName) : path.join(installing, source.fileName);
    let backup = "";
    try {
      if (source.archive) await extractArchive(temporary, installing);
      else fs.renameSync(temporary, target);
      if (!fs.existsSync(source.archive ? (source.entrypoint ? path.join(installing, source.entrypoint) : installing) : target)) {
        throw modelError("MODEL_INSTALL_FAILED", "模型安装后没有找到预期文件。");
      }
      if (fs.existsSync(directory)) {
        backup = `${directory}.old-${randomSuffix()}`;
        fs.renameSync(directory, backup);
      }
      fs.renameSync(installing, directory);
      if (backup) fs.rmSync(backup, { recursive: true, force: true });
    } catch (error) {
      if (fs.existsSync(directory) && backup && !fs.existsSync(backup)) {
        try { fs.renameSync(directory, backup); } catch (restoreError) {}
      }
      fs.rmSync(installing, { recursive: true, force: true });
      if (backup && fs.existsSync(backup) && !fs.existsSync(directory)) {
        try { fs.renameSync(backup, directory); } catch (restoreError) {}
      }
      throw error;
    } finally {
      fs.rmSync(temporary, { force: true });
      if (backup && fs.existsSync(backup)) fs.rmSync(backup, { recursive: true, force: true });
    }
  }

  async download(modelId, notify = () => {}) {
    const model = this.catalog.find((item) => item.id === modelId);
    if (!model) throw modelError("UNKNOWN_MODEL", "未知识别模型。");
    const source = this.sourceFor(model);
    if (!source.url) {
      throw modelError("MODEL_SOURCE_NOT_CONFIGURED", "当前发行包未配置该模型的下载来源，请安装包含官方模型清单的版本。");
    }
    const temporary = path.join(this.root, `.${model.id}.${randomSuffix()}.download`);
    fs.mkdirSync(this.root, { recursive: true });
    try {
      const response = await fetch(source.url);
      await this.writeResponse(response, temporary, source, notify);
      await this.installDirectory(temporary, model, source);
    } catch (error) {
      fs.rmSync(temporary, { force: true });
      if (error?.code) throw error;
      throw modelError("MODEL_DOWNLOAD_FAILED", error.message || "模型下载失败。");
    }
    const state = this.readState();
    state[model.id] = {
      installed: true,
      version: source.version,
      sha256: source.sha256,
      archive: source.archive,
      updatedAt: Date.now(),
    };
    this.writeState(state);
    return (await this.list()).find((item) => item.id === model.id);
  }

  async uninstall(modelId) {
    const model = this.catalog.find((item) => item.id === modelId);
    if (!model) throw modelError("UNKNOWN_MODEL", "未知识别模型。");
    fs.rmSync(path.join(this.root, model.id), { recursive: true, force: true });
    const state = this.readState();
    delete state[model.id];
    this.writeState(state);
    return { success: true };
  }

  async pathsForMode(mode) {
    const requiredKinds = mode === "ocr" ? ["ocr"] : mode === "asr" ? ["asr"] : ["ocr", "asr"];
    const models = await this.list();
    const missing = models.filter((model) => requiredKinds.includes(model.kind) && !model.installed);
    if (missing.length) {
      const labels = missing.map((model) => model.kind === "ocr" ? "OCR" : "ASR");
      throw modelError("MODEL_NOT_INSTALLED", `请先下载${labels.join("和")}模型。`);
    }
    return Object.fromEntries(
      models
        .filter((model) => requiredKinds.includes(model.kind))
        .map((model) => [model.kind, this.installedPath(model, this.sourceFor(model))]),
    );
  }
}

module.exports = { MODEL_CATALOG, ModelStore, safeFilePart, normalizeSha256 };
