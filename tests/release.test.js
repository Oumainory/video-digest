const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const release = require("../companion/release-config.cjs");

const CHROME_ID = "abcdefghijklmnopabcdefghijklmnop";
const EDGE_ID = "ponmlkjihgfedcbaponmlkjihgfedcba";

test("发行配置同时支持 Chrome 和 Edge 的扩展来源", () => {
  assert.deepEqual(release.extensionIds({ chrome: CHROME_ID, edge: EDGE_ID }), [CHROME_ID, EDGE_ID]);
  const manifest = release.nativeManifest({
    chromeExtensionId: CHROME_ID,
    edgeExtensionId: EDGE_ID,
    hostPath: "C:/Program Files/Video Digest Companion/Video Digest Companion.exe",
  });
  assert.equal(manifest.name, release.HOST_NAME);
  assert.deepEqual(manifest.allowed_origins, [
    `chrome-extension://${CHROME_ID}/`,
    `chrome-extension://${EDGE_ID}/`,
  ]);
});

test("发行配置拒绝占位或不合法扩展 ID", () => {
  assert.throws(
    () => release.extensionIds({ chrome: "REPLACE_WITH_EXTENSION_ID" }),
    /Chrome 扩展 ID/,
  );
  assert.throws(
    () => release.nativeManifest({ chromeExtensionId: CHROME_ID }),
    /host 缺少/,
  );
});

test("NSIS 安装钩子会注册并卸载 Native Messaging host", () => {
  const hooks = release.nsisHooks({ chromeExtensionId: CHROME_ID, edgeExtensionId: EDGE_ID });
  assert.match(hooks, /!macro customInstall/);
  assert.match(hooks, /-ExtensionId/);
  assert.match(hooks, /-EdgeExtensionId/);
  assert.match(hooks, /!macro customUnInstall/);
  assert.match(hooks, /-Unregister/);
});

test("Windows 打包脚本与桌面发行准备脚本存在", () => {
  assert.equal(fs.existsSync(path.join(__dirname, "..", "scripts", "package.ps1")), true);
  assert.equal(fs.existsSync(path.join(__dirname, "..", "companion", "build-release.cjs")), true);
  assert.equal(fs.existsSync(path.join(__dirname, "..", "companion", "model-sources.example.json")), true);
  assert.equal(fs.existsSync(path.join(__dirname, "..", "scripts", "test-release.ps1")), true);
  assert.equal(fs.existsSync(path.join(__dirname, "..", "docs", "release-test-checklist.md")), true);
});

test("真实引擎资产全部固定版本、大小、SHA 和许可证", () => {
  const lock = JSON.parse(fs.readFileSync(
    path.join(__dirname, "..", "engine-src", "release-assets.lock.json"),
    "utf8",
  ));
  assert.equal(lock.schemaVersion, 1);
  assert.deepEqual(lock.assets.map((asset) => asset.id), [
    "videocr-cpu",
    "whisper-cpp",
    "whisper-model-base-multilingual",
    "ffmpeg-lgpl",
  ]);
  for (const asset of lock.assets) {
    assert.match(asset.sha256, /^[a-f0-9]{64}$/);
    assert.ok(asset.sizeBytes > 0);
    assert.ok(asset.version);
    assert.ok(asset.license);
    assert.doesNotMatch(asset.sourceUrl || "", /\/releases\/download\/latest\//);
  }
});
