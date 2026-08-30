"use strict";

const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(process.argv[2] || process.cwd());
const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
const files = [
  manifest.background?.service_worker,
  manifest.side_panel?.default_path,
  manifest.options_ui?.page,
  ...(manifest.content_scripts || []).flatMap((item) => item.js || []),
  ...Object.values(manifest.action?.default_icon || {}),
  ...Object.values(manifest.icons || {}),
].filter(Boolean);

for (const page of [manifest.side_panel?.default_path, manifest.options_ui?.page]) {
  if (!page) continue;
  const html = fs.readFileSync(path.join(root, page), "utf8");
  files.push(...[...html.matchAll(/<script src="([^"]+)"/g)].map((match) => match[1]));
  files.push(...[...html.matchAll(/<link[^>]+href="([^"]+)"/g)].map((match) => match[1]));
}

const worker = fs.readFileSync(path.join(root, manifest.background.service_worker), "utf8");
const block = worker.match(/importScripts\(([\s\S]*?)\);/);
if (block) files.push(...[...block[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]));

const missing = [...new Set(files)].filter((file) => !fs.existsSync(path.join(root, file)));
if (missing.length) throw new Error(`清单引用了不存在的文件：${missing.join(", ")}`);
