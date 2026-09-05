const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..");

function createElement(tagName = "div") {
  const listeners = new Map();
  let text = "";
  const element = {
    tagName: tagName.toUpperCase(),
    value: "",
    hidden: false,
    children: [],
    focused: false,
    href: "",
    download: "",
    appendChild(child) {
      this.children.push(child);
      return child;
    },
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(listener);
    },
    async dispatch(type, event = {}) {
      for (const listener of listeners.get(type) || []) await listener(event);
    },
    focus() {
      this.focused = true;
    },
  };
  Object.defineProperty(element, "textContent", {
    get: () => text,
    set(value) {
      text = String(value);
      if (text === "") element.children = [];
    },
  });
  return element;
}

async function createContext() {
  const elements = new Map();
  const permissionRequests = [];
  const sent = [];
  const downloads = [];
  const storageWrites = [];
  const byId = (id) => {
    if (!elements.has(id)) {
      const tag = id === "preset" || id === "protocol" || id === "youtubeTranscriptProvider"
        ? "select"
        : id.endsWith("Btn")
          ? "button"
          : "div";
      const element = createElement(tag);
      if (id === "modelOptions" || id === "modelFilter") element.hidden = true;
      elements.set(id, element);
    }
    return elements.get(id);
  };

  const settings = require("../settings.js");
  const context = {
    console,
    setTimeout: () => 1,
    clearTimeout: () => {},
    document: {
      getElementById: byId,
      createElement: (tag) => {
        const node = createElement(tag);
        if (tag === "a") {
          node.click = () => downloads.push({ href: node.href, download: node.download });
        }
        return node;
      },
      documentElement: { dataset: {} },
    },
    window: { confirm: () => true },
    Blob: class {
      constructor(parts) {
        this.parts = parts;
      }
    },
    URL: {
      createObjectURL: () => "blob:backup",
      revokeObjectURL() {},
    },
    chrome: {
      storage: {
        local: {
          get: async () => ({
            [settings.STORAGE_KEY]: {
              presetId: settings.CUSTOM_PRESET_ID,
              protocol: settings.PROTOCOLS.OPENAI,
              aiBaseUrl: "https://api.example.com/v1",
              aiApiKey: "sk-test",
              aiModel: "already-filled-model",
            },
          }),
          set: async (value) => storageWrites.push(value),
        },
      },
      runtime: {
        async sendMessage(message) {
          sent.push(message);
          if (message.action === "exportLearningBackup") {
            return {
              success: true,
              backup: {
                kind: "bilibili-digest-backup",
                notes: [{ id: "n1", text: "笔记" }],
                learning: [],
              },
            };
          }
          if (message.action === "importLearningBackup") {
            return { success: true, notesAdded: 1, notesUpdated: 0 };
          }
          return { success: true };
        },
      },
      permissions: {
        contains: async () => true,
        request: async (request) => {
          permissionRequests.push(request);
          return true;
        },
      },
    },
    fetch: async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        data: [{ id: "model-b" }, { id: "model-a" }],
      }),
    }),
    BILI_SETTINGS: settings,
    BILI_AI_PROVIDER: require("../lib/ai-provider.js"),
  };
  context.globalThis = context;
  vm.createContext(context);

  const source = fs.readFileSync(path.join(ROOT, "options.js"), "utf8");
  vm.runInContext(
    `${source}\n;globalThis.__api = { fetchModels, clearModelOptions, exportBackup, saveSubtitleSettings };`,
    context,
  );
  await new Promise((resolve) => setImmediate(resolve));
  return { ...context.__api, el: byId, permissionRequests, sent, downloads, storageWrites };
}

test("模型列表使用可交互筛选框与自定义列表，不依赖原生 select 下拉菜单", () => {
  const html = fs.readFileSync(path.join(ROOT, "options.html"), "utf8");
  assert.doesNotMatch(html, /<datalist\b/i);
  assert.doesNotMatch(html, /\blist=["']modelOptions["']/i);
  assert.match(html, /<input[^>]+id=["']modelFilter["']/i);
  assert.match(html, /<div[^>]+id=["']modelOptions["'][^>]+role=["']listbox["']/i);
});

test("设置页提供自动、较短、较长三档概览分块模式", () => {
  const html = fs.readFileSync(path.join(ROOT, "options.html"), "utf8");
  assert.match(html, /id=["']analysisChunkMode["']/);
  for (const value of ["auto", "short", "long"]) {
    assert.match(html, new RegExp(`value=["']${value}["']`));
  }
});

test("设置页说明并允许选择 YouTube 官方字幕或 Supadata", () => {
  const html = fs.readFileSync(path.join(ROOT, "options.html"), "utf8");
  assert.match(html, /id=["']youtubeTranscriptProvider["']/);
  assert.match(html, /YouTube 官方字幕/);
  assert.match(html, /Supadata 原生字幕/);
  assert.match(html, /不需要密钥或额外配额/);
  assert.match(html, /需要 API Key 并消耗配额/);
});

test("字幕设置同时保存来源选择和 Supadata 密钥", async () => {
  const ctx = await createContext();
  ctx.el("youtubeTranscriptProvider").value = "supadata";
  ctx.el("supadataApiKey").value = "supa-test-key";

  await ctx.saveSubtitleSettings();

  const saved = ctx.storageWrites.at(-1).bili_digest_settings;
  assert.equal(saved.youtubeTranscriptProvider, "supadata");
  assert.equal(saved.supadataApiKey, "supa-test-key");
  assert.match(ctx.el("subtitleStatus").textContent, /Supadata/);
});

test("设置页用数字自调界面字号，不必走保存并授权", () => {
  const html = fs.readFileSync(path.join(ROOT, "options.html"), "utf8");
  assert.match(html, /id=["']uiFontScale["']/);
  assert.match(html, /type=["']number["']/);
  assert.match(html, /min=["']80["']/);
  assert.match(html, /max=["']160["']/);
});

test("设置页允许调整相邻分块重复的上下文字符数", () => {
  const html = fs.readFileSync(path.join(ROOT, "options.html"), "utf8");
  assert.match(html, /id=["']analysisOverlapChars["']/);
  assert.match(html, /分块重叠字符数/);
});

test("拉取后在原位置显示可筛选模型列表，不显示两套重复控件", async () => {
  const ctx = await createContext();

  await ctx.el("fetchModelsBtn").dispatch("click");

  const picker = ctx.el("modelOptions");
  assert.deepEqual(
    ctx.permissionRequests.map((request) => request.origins[0]),
    ["https://api.example.com/"],
    "权限申请应直接发生在按钮点击调用栈，兼容 Chrome 与 Edge 的用户手势要求",
  );
  assert.equal(picker.hidden, false);
  assert.equal(ctx.el("aiModel").hidden, true);
  assert.deepEqual(
    picker.children.map((option) => option.value),
    ["already-filled-model", "model-a", "model-b", ""],
  );
  assert.equal(ctx.el("aiModel").value, "already-filled-model");

  const modelB = picker.children.find((option) => option.value === "model-b");
  await modelB.dispatch("click");
  assert.equal(ctx.el("aiModel").value, "model-b");

  const manual = picker.children.find((option) => option.value === "");
  await manual.dispatch("click");
  assert.equal(picker.hidden, true);
  assert.equal(ctx.el("aiModel").hidden, false);
  assert.equal(ctx.el("aiModel").focused, true);
});

test("拉取模型后可以通过文本框筛选下拉列表", async () => {
  const ctx = await createContext();
  await ctx.el("fetchModelsBtn").dispatch("click");

  const filter = ctx.el("modelFilter");
  assert.equal(filter.hidden, false);
  filter.value = "model-b";
  await filter.dispatch("input");
  assert.deepEqual(
    ctx.el("modelOptions").children.map((option) => option.value),
    ["already-filled-model", "model-b", ""],
  );
  assert.equal(ctx.el("modelOptions").hidden, false);
});

test("设置页可以导出学习资料备份，且不含密钥", async () => {
  const html = fs.readFileSync(path.join(ROOT, "options.html"), "utf8");
  assert.match(html, /id=["']backupExportBtn["']/);
  assert.match(html, /恢复备份/);

  const ctx = await createContext();
  await ctx.exportBackup();
  assert.equal(ctx.sent[0].action, "exportLearningBackup");
  assert.equal(ctx.downloads[0].download, "bilibili-digest-backup.json");
  assert.match(ctx.el("backupStatus").textContent, /1 条笔记/);
});
