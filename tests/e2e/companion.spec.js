const { test, expect, _electron: electron } = require("@playwright/test");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.join(__dirname, "..", "..");
const COMPANION = path.join(ROOT, "companion");
const MAIN = path.join(COMPANION, "main.cjs");
const FAKE_ENGINE = path.join(ROOT, "tests", "fixtures", "fake-engine.cjs");
const electronPath = require(path.join(COMPANION, "node_modules", "electron"));

async function createFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "video-digest-electron-e2e-"));
  const engineDir = path.join(root, "engine");
  fs.mkdirSync(engineDir);
  fs.writeFileSync(path.join(engineDir, "manifest.json"), JSON.stringify({
    executable: process.execPath,
    args: [FAKE_ENGINE, "--config", "{{configPath}}"],
    supportsPause: true,
  }), "utf8");
  const media = path.join(root, "owned-test-media.mp4");
  fs.writeFileSync(media, "video-digest-owned-e2e-fixture", "utf8");
  const modelBytes = Buffer.from("video-digest-e2e-model", "utf8");
  const modelHash = crypto.createHash("sha256").update(modelBytes).digest("hex");
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": modelBytes.length });
    response.end(modelBytes);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const sourceFile = path.join(root, "model-sources.json");
  const writeModelSource = (sha256) => fs.writeFileSync(sourceFile, JSON.stringify({
    "whisper-multilingual": {
      url: `http://127.0.0.1:${server.address().port}/model.bin`,
      fileName: "model.bin",
      version: "e2e",
      sha256,
      sizeBytes: modelBytes.length,
      license: "Synthetic E2E fixture",
    },
  }), "utf8");
  writeModelSource("0".repeat(64));
  return {
    root, engineDir, media, userData: path.join(root, "user-data"),
    modelHash, sourceFile, writeModelSource, server,
  };
}

async function launchCompanion(fixture) {
  const app = await electron.launch({
    executablePath: electronPath,
    args: [MAIN, "--no-sandbox"],
    cwd: COMPANION,
    env: {
      ...process.env,
      ELECTRON_DISABLE_SANDBOX: "1",
      ELECTRON_ENABLE_LOGGING: "1",
      VIDEO_DIGEST_TEST_USER_DATA: fixture.userData,
      VIDEO_DIGEST_ENGINE_DIR: fixture.engineDir,
      VIDEO_DIGEST_MODEL_SOURCES_FILE: fixture.sourceFile,
      VIDEO_DIGEST_TEST_ALLOW_HTTP: "1",
      VIDEO_DIGEST_FAKE_ENGINE_DELAY_MS: "260",
    },
  });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  return { app, page };
}

test("真正的 Electron 主进程、preload、renderer 可完成暂停恢复、编辑、导出和重启恢复", async () => {
  const fixture = await createFixture();
  let app;
  try {
    ({ app } = await launchCompanion(fixture));
    let page = app.windows()[0];
    expect(await page.evaluate(() => ({
      companion: typeof window.companion,
      presetRegion: typeof window.companion?.protocol?.presetRegion,
      readyState: document.readyState,
    }))).toEqual({ companion: "object", presetRegion: "function", readyState: "complete" });
    await expect(page.locator("#connectionBadge")).toContainText("本地引擎已连接");

    const rejectedModel = await page.evaluate(async () => {
      try {
        await window.companion.downloadModel("whisper-multilingual");
        return null;
      } catch (error) {
        return { code: error.code, message: error.message };
      }
    });
    expect(rejectedModel.message).toContain("SHA-256");
    expect(fs.existsSync(path.join(fixture.userData, "models", "whisper-multilingual"))).toBe(false);
    fixture.writeModelSource(fixture.modelHash);
    const installedModel = await page.evaluate(() => window.companion.downloadModel("whisper-multilingual"));
    expect(installedModel.model.installed).toBe(true);
    expect(fs.readFileSync(path.join(fixture.userData, "models", "whisper-multilingual", "model.bin"))).toEqual(
      Buffer.from("video-digest-e2e-model", "utf8"),
    );

    const task = await page.evaluate((media) => window.companion.startTask({
      sourceId: "electron-e2e",
      filePath: media,
      fileName: "owned-test-media.mp4",
      mode: "ocr",
      language: "zh",
    }), fixture.media);
    await expect(page.locator("#taskCard")).toBeVisible();
    await page.evaluate((id) => window.companion.pauseTask(id), task.id);
    await expect(page.locator("#taskMessage")).toContainText("暂停");
    const pausedPercent = await page.locator("#taskPercent").textContent();
    await page.waitForTimeout(400);
    await expect(page.locator("#taskPercent")).toHaveText(pausedPercent);
    await page.evaluate((id) => window.companion.resumeTask(id), task.id);

    await expect(page.locator("#resultCard")).toBeVisible();
    await expect(page.locator(".result-edit").first()).toContainText("第一行画面字幕");
    await page.locator(".result-edit").first().fill("人工校正后的字幕");
    await page.locator("#saveResultButton").click();
    await expect(page.locator("#saveResultButton")).toBeDisabled();

    await page.evaluate(() => {
      window.__videoDigestExports = [];
      URL.createObjectURL = (blob) => {
        window.__videoDigestExportBlob = blob;
        return "blob:video-digest-e2e";
      };
      URL.revokeObjectURL = () => {};
      HTMLAnchorElement.prototype.click = function click() {
        const fileName = this.download;
        window.__videoDigestExportBlob.text().then((text) => {
          window.__videoDigestExports.push({ fileName, text });
        });
      };
    });
    for (const [index, format] of ["srt", "vtt", "ass"].entries()) {
      await page.locator(`.export-button[data-format="${format}"]`).click();
      await expect.poll(() => page.evaluate(() => window.__videoDigestExports.length)).toBe(index + 1);
      const exported = await page.evaluate((position) => window.__videoDigestExports[position], index);
      expect(exported.fileName).toMatch(new RegExp(`\\.${format}$`));
      expect(exported.text.length).toBeGreaterThan(20);
    }

    const cancelTask = await page.evaluate((media) => window.companion.startTask({
      sourceId: "electron-cancel-e2e",
      filePath: media,
      fileName: "cancel.mp4",
      mode: "ocr",
    }), fixture.media);
    await page.evaluate((id) => window.companion.cancelTask(id), cancelTask.id);
    await expect.poll(async () => page.evaluate(async (id) => {
      const tasks = await window.companion.listTasks();
      return tasks.find((item) => item.id === id)?.state;
    }, cancelTask.id)).toBe("canceled");
    await expect.poll(() => {
      const taskDir = path.join(fixture.engineDir, ".tasks");
      return fs.existsSync(taskDir) ? fs.readdirSync(taskDir).length : 0;
    }).toBe(0);

    await app.close();
    app = null;
    ({ app, page } = await launchCompanion(fixture));
    await expect(page.locator("#resultCard")).toBeVisible();
    await expect(page.locator(".result-edit").first()).toContainText("人工校正后的字幕");
    const stored = JSON.parse(fs.readFileSync(path.join(fixture.userData, "results", "electron-e2e.json"), "utf8"));
    expect(stored.tracks.ocr.segments[0].text).toBe("人工校正后的字幕");
    expect(crypto.createHash("sha256").update(fs.readFileSync(fixture.media)).digest("hex")).toHaveLength(64);
  } finally {
    if (app) await app.close().catch(() => {});
    await new Promise((resolve) => fixture.server.close(resolve));
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});
