const { test, expect, chromium } = require("@playwright/test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.join(__dirname, "..", "..");
const EXTENSION_ROOT = process.env.VIDEO_DIGEST_EXTENSION_ROOT
  ? path.resolve(process.env.VIDEO_DIGEST_EXTENSION_ROOT)
  : ROOT;
const BVID = "BV1xx411c7mD";
const YOUTUBE_ID = "dQw4w9WgXcQ";

function playerResponse(id = YOUTUBE_ID, { captions = true, automatic = false, language = "en" } = {}) {
  return {
    videoDetails: { videoId: id, title: `Video ${id}`, author: "Fixture", lengthSeconds: "12" },
    captions: captions ? {
      playerCaptionsTracklistRenderer: {
        captionTracks: [{
          baseUrl: `https://www.youtube.com/api/timedtext?v=${id}&lang=${language}`,
          languageCode: language,
          name: { simpleText: language === "zh-Hans" ? "中文" : "English" },
          kind: automatic ? "asr" : "",
        }],
      },
    } : undefined,
  };
}

function youtubeHtml(response) {
  return `<!doctype html><html><head><title>${response.videoDetails.title}</title></head><body>
    <div id="movie_player"></div><div class="ytp-right-controls"></div>
    <video class="html5-main-video"></video>
    <script>window.ytInitialPlayerResponse = ${JSON.stringify(response)};<\/script>
  </body></html>`;
}

function captionJson(text = "Hello from a mocked YouTube caption") {
  return JSON.stringify({ events: [
    { tStartMs: 1000, dDurationMs: 1500, segs: [{ utf8: text }] },
    { tStartMs: 3000, dDurationMs: 1000, segs: [{ utf8: "Second line" }] },
  ] });
}

async function switchYoutubeVideo(page, response) {
  await page.evaluate((next) => {
    history.pushState({}, "", `/watch?v=${next.videoDetails.videoId}`);
    window.ytInitialPlayerResponse = next;
    document.title = next.videoDetails.title;
    document.dispatchEvent(new Event("yt-navigate-finish"));
  }, response);
  await expect(page).toHaveURL(new RegExp(response.videoDetails.videoId));
}

async function launchExtension() {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "video-digest-extension-e2e-"));
  const localEdge = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
  const executablePath = process.env.PLAYWRIGHT_EXTENSION_EXECUTABLE
    || (!process.env.CI && process.platform === "win32" && fs.existsSync(localEdge) ? localEdge : undefined);
  const context = await chromium.launchPersistentContext(userDataDir, {
    ...(executablePath ? { executablePath } : { channel: "chromium" }),
    headless: true,
    args: [`--disable-extensions-except=${EXTENSION_ROOT}`, `--load-extension=${EXTENSION_ROOT}`],
  });
  let worker = context.serviceWorkers()[0];
  if (!worker) worker = await context.waitForEvent("serviceworker");
  return { context, worker, userDataDir };
}

async function tabFor(worker, urlPart) {
  return worker.evaluate(async (part) => {
    const tabs = await chrome.tabs.query({});
    const tab = tabs.find((item) => String(item.url || "").includes(part));
    return tab ? { id: tab.id, windowId: tab.windowId, url: tab.url } : null;
  }, urlPart);
}

async function sendFromExtension(context, worker, message) {
  const extensionId = new URL(worker.url()).host;
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/options.html`);
  return page.evaluate((value) => chrome.runtime.sendMessage(value), message);
}

test("B站侧边栏 owner 只属于打开它的标签页，切走再切回仍保持", async () => {
  const fixture = await launchExtension();
  try {
    await fixture.context.route("https://www.bilibili.com/**", (route) => route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><html><body><h1 class="video-title">Bili fixture</h1>
        <div id="bilibili-player"><div class="bpx-player-primary-area"><div><video></video></div></div></div>
        <div class="video-toolbar-left"></div></body></html>`,
    }));
    const ownerPage = await fixture.context.newPage();
    await ownerPage.goto(`https://www.bilibili.com/video/${BVID}`);
    await expect(ownerPage.locator("#bili-digest-button")).toBeVisible({ timeout: 8000 });
    const otherPage = await fixture.context.newPage();
    await otherPage.goto(`https://www.bilibili.com/video/${BVID}?p=2`);
    await expect(otherPage.locator("#bili-digest-button")).toBeVisible({ timeout: 8000 });

    await ownerPage.bringToFront();
    await ownerPage.locator("#bili-digest-button").click();
    const ownerTab = await tabFor(fixture.worker, `/${BVID}`);
    const tabs = await fixture.worker.evaluate(() => chrome.tabs.query({ currentWindow: true }));
    const otherTab = tabs.find((tab) => tab.id !== ownerTab.id && String(tab.url).includes("bilibili.com/video"));
    await expect.poll(() => fixture.worker.evaluate(async ({ ownerId, otherId, windowId }) => {
      const saved = await chrome.storage.session.get("video_digest_panel_owners");
      const owner = await chrome.sidePanel.getOptions({ tabId: ownerId });
      const other = await chrome.sidePanel.getOptions({ tabId: otherId });
      return {
        savedOwner: saved.video_digest_panel_owners?.[windowId],
        ownerEnabled: owner.enabled,
        otherEnabled: other.enabled,
      };
    }, { ownerId: ownerTab.id, otherId: otherTab.id, windowId: ownerTab.windowId })).toEqual({
      savedOwner: ownerTab.id,
      ownerEnabled: true,
      otherEnabled: false,
    });

    await otherPage.bringToFront();
    await ownerPage.bringToFront();
    await expect.poll(() => fixture.worker.evaluate(async (tabId) => (
      await chrome.sidePanel.getOptions({ tabId })
    ).enabled, ownerTab.id)).toBe(true);
  } finally {
    await fixture.context.close();
    fs.rmSync(fixture.userDataDir, { recursive: true, force: true });
  }
});

test("B站人工/AI/多语言/无字幕通过真实 service worker 与本地拦截响应", async () => {
  const fixture = await launchExtension();
  let subtitleMode = "human";
  try {
    await fixture.context.route("https://api.bilibili.com/x/web-interface/view**", (route) => route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ code: 0, data: {
        bvid: BVID, aid: 101, cid: 202, title: "Bili E2E", desc: "fixture",
        duration: 12, owner: { name: "Fixture UP" }, pages: [{ page: 1, cid: 202, duration: 12, part: "P1" }],
      } }),
    }));
    await fixture.context.route("https://api.bilibili.com/x/web-interface/nav**", (route) => route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ code: 0, data: { wbi_img: {
        img_url: `https://i0.hdslb.com/bfs/wbi/${"a".repeat(64)}.png`,
        sub_url: `https://i0.hdslb.com/bfs/wbi/${"b".repeat(64)}.png`,
      } } }),
    }));
    await fixture.context.route("https://api.bilibili.com/x/player/wbi/v2**", (route) => {
      const subtitles = subtitleMode === "none" ? [] : subtitleMode === "ai" ? [{
        id: 2, lan: "ai-en", lan_doc: "English (auto)", ai_type: 1,
        subtitle_url: "https://i0.hdslb.com/subtitle/ai.json",
      }] : [
        { id: 1, lan: "zh-CN", lan_doc: "中文", subtitle_url: "https://i0.hdslb.com/subtitle/human.json" },
        { id: 2, lan: "ai-en", lan_doc: "English (auto)", ai_type: 1, subtitle_url: "https://i0.hdslb.com/subtitle/ai.json" },
      ];
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ code: 0, data: { subtitle: { subtitles } } }),
      });
    });
    await fixture.context.route("https://i0.hdslb.com/subtitle/**", (route) => route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ body: [
        { from: 1, to: 2.5, content: subtitleMode === "ai" ? "automatic caption" : "人工字幕" },
        { from: 3, to: 4, content: "第二行" },
      ] }),
    }));

    const human = await sendFromExtension(fixture.context, fixture.worker, {
      action: "fetchTranscript", bvid: BVID, page: 1, forceRefresh: true,
    });
    expect(human.success).toBe(true);
    expect(human.language).toBe("zh-CN");
    expect(human.isAiSubtitle).toBe(false);
    expect(human.availableTracks).toHaveLength(2);

    subtitleMode = "ai";
    const automatic = await sendFromExtension(fixture.context, fixture.worker, {
      action: "fetchTranscript", bvid: BVID, page: 1, forceRefresh: true,
    });
    expect(automatic.success).toBe(true);
    expect(automatic.isAiSubtitle).toBe(true);

    subtitleMode = "none";
    const none = await sendFromExtension(fixture.context, fixture.worker, {
      action: "fetchTranscript", bvid: BVID, page: 1, forceRefresh: true,
    });
    expect(none.success).toBe(false);
    expect(none.error).toBe("NO_SUBTITLE");
  } finally {
    await fixture.context.close();
    fs.rmSync(fixture.userDataDir, { recursive: true, force: true });
  }
});

test("YouTube 人工/自动字幕、多语言、无字幕、空字幕和 SPA 切视频走完整扩展链路", async () => {
  const fixture = await launchExtension();
  try {
    let activeResponse = playerResponse();
    activeResponse.captions.playerCaptionsTracklistRenderer.captionTracks[0].baseUrl += "&source=static";
    let activeCaption = captionJson();
    let activeContentType = "application/json";
    await fixture.context.route("https://www.youtube.com/api/timedtext**", (route) => {
      const source = new URL(route.request().url()).searchParams.get("source");
      return route.fulfill({
        contentType: activeContentType,
        body: source === "static" ? "" : activeCaption,
      });
    });
    await fixture.context.route("https://www.youtube.com/watch**", (route) => route.fulfill({
      contentType: "text/html",
      body: youtubeHtml(activeResponse),
    }));

    const page = await fixture.context.newPage();
    await page.goto(`https://www.youtube.com/watch?v=${YOUTUBE_ID}`);
    await expect(page.locator("#video-digest-youtube-button")).toBeVisible();
    await page.evaluate((id) => new Promise((resolve) => {
      const request = new XMLHttpRequest();
      request.open(
        "GET",
        `https://www.youtube.com/api/timedtext?v=${id}&lang=en&source=player&fmt=json3`,
      );
      request.addEventListener("loadend", resolve, { once: true });
      request.send();
    }), YOUTUBE_ID);
    const firstTab = await tabFor(fixture.worker, YOUTUBE_ID);
    const result = await fixture.worker.evaluate((tabId) => chrome.tabs.sendMessage(tabId, {
      action: "getYoutubeTranscript",
      forceRefresh: true,
      languagePreference: ["en"],
    }), firstTab.id);
    expect(result.success).toBe(true);
    expect(result.transcript.map((item) => item.text || item.content).join(" ")).toContain("mocked YouTube");
    expect(result.language).toBe("en");
    expect(result.isAiSubtitle).toBe(false);

    const autoId = "a1b2c3d4e5F";
    activeResponse = playerResponse(autoId, { automatic: true, language: "zh-Hans" });
    activeCaption = captionJson("自动生成字幕");
    await switchYoutubeVideo(page, activeResponse);
    const autoTab = await tabFor(fixture.worker, autoId);
    const automatic = await fixture.worker.evaluate((tabId) => chrome.tabs.sendMessage(tabId, {
      action: "getYoutubeTranscript", forceRefresh: true, languagePreference: ["zh-Hans"],
    }), autoTab.id);
    expect(automatic.success).toBe(true);
    expect(automatic.isAiSubtitle).toBe(true);
    expect(automatic.language).toBe("zh-Hans");

    const xmlId = "xmlCapt0001";
    activeResponse = playerResponse(xmlId);
    activeCaption = '<transcript><text start="1.25" dur="2">XML &amp; subtitle</text></transcript>';
    activeContentType = "application/xml";
    await switchYoutubeVideo(page, activeResponse);
    const xmlTab = await tabFor(fixture.worker, xmlId);
    const xml = await fixture.worker.evaluate((tabId) => chrome.tabs.sendMessage(tabId, {
      action: "getYoutubeTranscript", forceRefresh: true,
    }), xmlTab.id);
    expect(xml.success).toBe(true);
    expect(xml.transcript[0].text).toBe("XML & subtitle");

    const noCaptionId = "noCapt00001";
    activeResponse = playerResponse(noCaptionId, { captions: false });
    await switchYoutubeVideo(page, activeResponse);
    const noCaptionTab = await tabFor(fixture.worker, noCaptionId);
    const noCaption = await fixture.worker.evaluate((tabId) => chrome.tabs.sendMessage(tabId, {
      action: "getYoutubeTranscript", forceRefresh: true,
    }), noCaptionTab.id);
    expect(noCaption.success).toBe(false);
    expect(noCaption.error).toBe("NO_SUBTITLE");

    const emptyId = "emptyCap001";
    activeResponse = playerResponse(emptyId);
    activeCaption = "";
    activeContentType = "application/json";
    await switchYoutubeVideo(page, activeResponse);
    const emptyTab = await tabFor(fixture.worker, emptyId);
    const empty = await fixture.worker.evaluate((tabId) => chrome.tabs.sendMessage(tabId, {
      action: "getYoutubeTranscript", forceRefresh: true,
    }), emptyTab.id);
    expect(empty.success).toBe(false);
    expect(empty.error).toBe("EMPTY_TRANSCRIPT");
  } finally {
    await fixture.context.close();
    fs.rmSync(fixture.userDataDir, { recursive: true, force: true });
  }
});
