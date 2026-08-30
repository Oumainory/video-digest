"use strict";

const fs = require("node:fs");
const path = require("node:path");

const [target, downloadUrl, version = "0.1.0"] = process.argv.slice(2);
if (!target || !downloadUrl) throw new Error("Usage: write-companion-release.cjs <target> <https-url> [version]");
const parsed = new URL(downloadUrl);
if (parsed.protocol !== "https:") throw new Error("Desktop companion download URL must use HTTPS.");

const source = `/** Generated during extension packaging. */
var BILI_COMPANION_RELEASE = (() => {
  const VERSION = ${JSON.stringify(version)};
  const DOWNLOAD_URL = ${JSON.stringify(parsed.toString())};
  function hasDownloadUrl() { return true; }
  return Object.freeze({ VERSION, DOWNLOAD_URL, hasDownloadUrl });
})();
if (typeof module !== "undefined" && module.exports) module.exports = BILI_COMPANION_RELEASE;
`;
fs.mkdirSync(path.dirname(target), { recursive: true });
fs.writeFileSync(target, source, "utf8");
