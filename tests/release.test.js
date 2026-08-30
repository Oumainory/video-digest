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
});
