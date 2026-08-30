"use strict";

const path = require("node:path");

const HOST_NAME = "com.video_digest.companion";
const EXTENSION_ID_PATTERN = /^[a-p]{32}$/;

function extensionId(value, label) {
  const id = String(value || "").trim();
  if (!EXTENSION_ID_PATTERN.test(id)) {
    throw new Error(`${label} 必须是 32 位小写 Chromium 扩展 ID。`);
  }
  return id;
}

function extensionIds({ chrome, edge } = {}) {
  const ids = [
    extensionId(chrome, "Chrome 扩展 ID"),
    edge ? extensionId(edge, "Edge 扩展 ID") : "",
  ].filter(Boolean);
  return [...new Set(ids)];
}

function nativeManifest({ chromeExtensionId, edgeExtensionId, hostPath }) {
  const ids = extensionIds({ chrome: chromeExtensionId, edge: edgeExtensionId });
  if (!hostPath) throw new Error("Native Messaging host 缺少可执行文件路径。");
  return {
    name: HOST_NAME,
    description: "Video Digest Companion Native Messaging host",
    path: path.resolve(hostPath),
    type: "stdio",
    allowed_origins: ids.map((id) => `chrome-extension://${id}/`),
  };
}

function nsisHooks({ chromeExtensionId, edgeExtensionId }) {
  const chrome = extensionId(chromeExtensionId, "Chrome 扩展 ID");
  const edge = edgeExtensionId ? extensionId(edgeExtensionId, "Edge 扩展 ID") : chrome;
  const script = "$INSTDIR\\resources\\native-host\\install-host.ps1";
  const host = "$INSTDIR\\Video Digest Companion.exe";
  const powershell = '"$SYSDIR\\WindowsPowerShell\\v1.0\\powershell.exe"';
  return [
    "!macro customInstall",
    `  ExecWait '${powershell} -NoProfile -ExecutionPolicy Bypass -File "${script}" -ExtensionId "${chrome}" -EdgeExtensionId "${edge}" -InstallDir "$INSTDIR\\resources\\native-host" -HostExecutable "${host}"'`,
    "!macroend",
    "",
    "!macro customUnInstall",
    `  ExecWait '${powershell} -NoProfile -ExecutionPolicy Bypass -File "${script}" -Unregister -InstallDir "$INSTDIR\\resources\\native-host"'`,
    "!macroend",
    "",
  ].join("\n");
}

module.exports = {
  HOST_NAME,
  EXTENSION_ID_PATTERN,
  extensionId,
  extensionIds,
  nativeManifest,
  nsisHooks,
};
