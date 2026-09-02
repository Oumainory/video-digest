/** YouTube 页面适配：只读取官方字幕，提供播放器跳转，不执行网页 OCR/ASR。 */
(() => {
  "use strict";

  const BUTTON_ID = "video-digest-youtube-button";
  const NOTE_BUTTON_ID = "video-digest-youtube-note-button";
  const PLAYER_BUTTON_SELECTORS = [
    ".ytp-right-controls",
    "ytd-watch-metadata #actions-inner",
    "#actions-inner",
  ];

  function videoElement() {
    return document.querySelector("video.html5-main-video") || document.querySelector("video");
  }

  function videoId() {
    try {
      const value = new URL(location.href).searchParams.get("v") || "";
      return /^[A-Za-z0-9_-]{11}$/.test(value) ? value : null;
    } catch (error) {
      return null;
    }
  }

  // 从脚本文本中取出 marker 后的完整 JSON；不能用懒惰正则，播放器响应里的
  // 字符串可能包含大括号。这个解析器只处理 JSON 必需的字符串和转义规则。
  function jsonAfterMarker(text, marker) {
    const start = String(text || "").indexOf(marker);
    if (start < 0) return null;
    const open = String(text).indexOf("{", start + marker.length);
    if (open < 0) return null;
    let depth = 0;
    let quoted = false;
    let escaped = false;
    for (let index = open; index < text.length; index += 1) {
      const char = text[index];
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') quoted = false;
        continue;
      }
      if (char === '"') {
        quoted = true;
        continue;
      }
      if (char === "{") depth += 1;
      if (char === "}") {
        depth -= 1;
        if (depth === 0) {
          try { return JSON.parse(text.slice(open, index + 1)); } catch (error) { return null; }
        }
      }
    }
    return null;
  }

  function playerResponse() {
    if (globalThis.ytInitialPlayerResponse && typeof globalThis.ytInitialPlayerResponse === "object") {
      return globalThis.ytInitialPlayerResponse;
    }
    const configured = globalThis.ytplayer?.config?.args?.player_response;
    if (typeof configured === "string") {
      try { return JSON.parse(configured); } catch (error) { /* try page scripts next */ }
    }
    for (const script of document.scripts) {
      const text = script.textContent || "";
      if (!text.includes("ytInitialPlayerResponse")) continue;
      const value = jsonAfterMarker(text, "ytInitialPlayerResponse");
      if (value) return value;
    }
    return null;
  }

  function readVideoInfo() {
    const video = videoElement();
    const title = document.querySelector("h1.ytd-watch-metadata yt-formatted-string")
      || document.querySelector("ytd-watch-metadata h1")
      || document.querySelector("h1.title");
    const owner = document.querySelector("ytd-channel-name a")
      || document.querySelector("ytd-video-owner-renderer a");
    return {
      videoId: videoId(),
      title: title?.textContent?.trim() || document.title.replace(/ - YouTube$/, "").trim(),
      owner: owner?.textContent?.trim() || "",
      duration: Number(video?.duration) || 0,
      currentTime: Number(video?.currentTime) || 0,
      url: location.href,
    };
  }

  async function getTranscript(languagePreference) {
    const id = videoId();
    const response = await chrome.runtime.sendMessage({
      action: "fetchYoutubeTranscript",
      videoId: id,
      sourceUrl: location.href,
      playerResponse: playerResponse(),
      languagePreference,
    });
    return response;
  }

  function injectButton() {
    if (!videoId() || document.getElementById(BUTTON_ID)) return;
    const button = document.createElement("button");
    button.id = BUTTON_ID;
    button.type = "button";
    button.textContent = "Digest";
    button.title = "打开 Video Digest 侧边栏";
    button.style.cssText = [
      "margin:0 6px;padding:5px 10px;border:0;border-radius:6px;",
      "color:#fff;background:#fb7299;font:12px system-ui;cursor:pointer;",
    ].join("");
    button.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      try {
        const result = await chrome.runtime.sendMessage({ action: "openSidePanel" });
        if (!result?.success) button.textContent = "请点工具栏图标";
      } catch (error) {
        button.textContent = "请点工具栏图标";
      }
      setTimeout(() => { if (button.isConnected) button.textContent = "Digest"; }, 2200);
    });
    const target = PLAYER_BUTTON_SELECTORS.map((selector) => document.querySelector(selector)).find(Boolean);
    if (!target) return;
    target.prepend(button);

    const note = document.createElement("button");
    note.id = NOTE_BUTTON_ID;
    note.type = "button";
    note.textContent = "笔记";
    note.title = "保存当前时间点的笔记";
    note.style.cssText = [
      "margin:0 6px;padding:5px 9px;border:0;border-radius:6px;",
      "color:#fff;background:rgba(0,0,0,.55);font:12px system-ui;cursor:pointer;",
    ].join("");
    note.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      saveNoteAtCurrentTime(note);
    });
    target.prepend(note);
  }

  async function saveNoteAtCurrentTime(button) {
    const id = videoId();
    const video = videoElement();
    if (!id || !video) return;
    const original = button.textContent;
    button.disabled = true;
    button.textContent = "保存中";
    try {
      const result = await chrome.runtime.sendMessage({
        action: "saveNote",
        bvid: `youtube:${id}`,
        page: 1,
        timestamp: Math.floor(Number(video.currentTime) || 0),
      });
      button.textContent = result?.success ? "已保存" : "先打开字幕";
    } catch (error) {
      button.textContent = "保存失败";
    } finally {
      setTimeout(() => {
        if (button.isConnected) {
          button.disabled = false;
          button.textContent = original;
        }
      }, 1800);
    }
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.action === "getVideoInfo") {
      sendResponse(readVideoInfo());
      return false;
    }
    if (message?.action === "getYoutubeTranscript") {
      getTranscript(message.languagePreference)
        .then(sendResponse)
        .catch((error) => sendResponse({ success: false, error: error.message || "YouTube 字幕获取失败。" }));
      return true;
    }
    if (message?.action === "getPlaybackTime") {
      const video = videoElement();
      sendResponse({ currentTime: Number(video?.currentTime) || 0, paused: video?.paused ?? true });
      return false;
    }
    if (message?.action === "seekTo") {
      const video = videoElement();
      if (!video) {
        sendResponse({ success: false, error: "NO_PLAYER" });
        return false;
      }
      video.currentTime = Math.max(0, Number(message.seconds) || 0);
      if (video.paused) video.play().catch(() => {});
      sendResponse({ success: true });
      return false;
    }
    return false;
  });

  document.addEventListener("keydown", (event) => {
    if (!/[nN]/.test(event.key) || event.ctrlKey || event.metaKey || event.altKey) return;
    const target = event.target;
    if (target?.tagName === "INPUT" || target?.tagName === "TEXTAREA" || target?.isContentEditable) return;
    const button = document.getElementById(NOTE_BUTTON_ID);
    if (!button || button.disabled) return;
    event.preventDefault();
    saveNoteAtCurrentTime(button);
  });

  const start = () => {
    injectButton();
    setInterval(injectButton, 1000);
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
  else start();
})();
