"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const required = [
  "README.md",
  ".gitignore",
  ".gitattributes",
  "LICENSE",
  "THIRD-PARTY-NOTICES",
  "manifest.json",
  "package.json",
  "companion/package.json",
  "companion/engine/manifest.example.json",
];

for (const file of required) {
  if (!fs.existsSync(path.join(root, file))) throw new Error(`Missing required file: ${file}`);
}

const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
const validator = spawnSync(process.execPath, [path.join(root, "scripts", "validate-package.cjs"), root], {
  cwd: root,
  encoding: "utf8",
});
if (validator.status !== 0) {
  process.stderr.write(validator.stderr || validator.stdout || "Extension package validation failed.\n");
  process.exit(1);
}

const files = new Set([
  "background.js",
  "content.js",
  "youtube-page.js",
  "youtube-content.js",
  "sidepanel.js",
  "options.js",
  "settings.js",
  ...fs.readdirSync(path.join(root, "lib")).filter((file) => file.endsWith(".js")).map((file) => path.join("lib", file)),
  ...fs.readdirSync(path.join(root, "companion")).filter((file) => file.endsWith(".cjs") || file.endsWith(".js")).map((file) => path.join("companion", file)),
]);

for (const relative of files) {
  const file = path.join(root, relative);
  if (!fs.existsSync(file)) continue;
  const result = spawnSync(process.execPath, ["--check", file], { cwd: root, encoding: "utf8" });
  if (result.status !== 0) {
    process.stderr.write(result.stderr || `Syntax check failed: ${relative}\n`);
    process.exit(1);
  }
}

if (manifest.update_url) throw new Error("Store extension manifest must not contain update_url.");
console.log("Video Digest checks passed.");
