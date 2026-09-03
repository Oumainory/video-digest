"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const lockFile = path.join(root, "engine-src", "release-assets.lock.json");
const lock = JSON.parse(fs.readFileSync(lockFile, "utf8"));
const ids = new Set();

if (lock.schemaVersion !== 1 || !Array.isArray(lock.assets) || lock.assets.length < 4) {
  throw new Error("真实引擎资产锁文件格式无效。");
}
for (const asset of lock.assets) {
  if (!asset.id || ids.has(asset.id)) throw new Error(`资产 ID 重复或为空：${asset.id || "<empty>"}`);
  ids.add(asset.id);
  if (!asset.version || !asset.fileName || !/^[a-f0-9]{64}$/.test(asset.sha256)) {
    throw new Error(`资产 ${asset.id} 缺少固定版本、文件名或 SHA-256。`);
  }
  if (!Number.isSafeInteger(asset.sizeBytes) || asset.sizeBytes <= 0) {
    throw new Error(`资产 ${asset.id} 缺少固定字节数。`);
  }
  if (asset.sourceUrl && /\/releases\/download\/latest\//i.test(asset.sourceUrl)) {
    throw new Error(`资产 ${asset.id} 使用了浮动 latest 下载地址。`);
  }
  if (!asset.license) throw new Error(`资产 ${asset.id} 缺少许可证记录。`);
}

const assetDirectory = process.argv[2] || process.env.VIDEO_DIGEST_ENGINE_ASSET_DIR;
if (!assetDirectory) {
  console.log(`Engine asset lock validated: ${lock.assets.length} pinned assets.`);
  process.exit(0);
}

for (const asset of lock.assets) {
  const file = path.resolve(assetDirectory, asset.fileName);
  const relative = path.relative(path.resolve(assetDirectory), file);
  if (relative.startsWith("..") || path.isAbsolute(relative) || !fs.existsSync(file)) {
    throw new Error(`缺少锁定资产：${asset.fileName}`);
  }
  const bytes = fs.readFileSync(file);
  const hash = crypto.createHash("sha256").update(bytes).digest("hex");
  if (bytes.length !== asset.sizeBytes) throw new Error(`${asset.fileName} 大小不匹配。`);
  if (hash !== asset.sha256) throw new Error(`${asset.fileName} SHA-256 不匹配。`);
  console.log(`Verified ${asset.id}: ${asset.fileName}`);
}
