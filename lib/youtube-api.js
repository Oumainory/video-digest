/**
 * YouTube 官方字幕数据源。
 *
 * 页面内容脚本读取 YouTube 自己下发的播放器响应，并可用页面实际请求过的
 * timedtext 地址兜底。字幕正文仍由 service worker 下载；扩展不会对网页视频
 * 截帧、录音或启动本地 OCR/ASR。
 */
var VIDEO_DIGEST_YOUTUBE = (() => {
  const DEFAULT_LANG_PREFERENCE = Object.freeze([
    "zh-Hans",
    "zh-CN",
    "zh-Hant",
    "zh-TW",
    "zh",
    "en",
    "en-US",
  ]);

  class YoutubeApiError extends Error {
    constructor(code, message) {
      super(message);
      this.name = "YoutubeApiError";
      this.code = code;
    }
  }

  function parseVideoId(input) {
    const text = String(input || "").trim();
    if (!text) return null;
    try {
      const url = new URL(text);
      const hostname = url.hostname.toLowerCase().replace(/^www\./, "");
      if (hostname === "youtu.be") {
        const id = url.pathname.split("/").filter(Boolean)[0] || "";
        return /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
      }
      if (["youtube.com", "m.youtube.com"].includes(hostname) && url.pathname === "/watch") {
        const id = url.searchParams.get("v") || "";
        return /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
      }
    } catch (error) {
      // 裸 video id 也接受，方便内容脚本与测试直接传值。
    }
    return /^[A-Za-z0-9_-]{11}$/.test(text) ? text : null;
  }

  function validatedCaptionUrl(trackUrl, videoId = null) {
    try {
      const url = new URL(String(trackUrl || ""));
      const hostname = url.hostname.toLowerCase();
      const expectedId = videoId ? parseVideoId(videoId) : null;
      if (
        url.protocol !== "https:"
        || !(hostname === "youtube.com" || hostname.endsWith(".youtube.com"))
        || url.pathname !== "/api/timedtext"
        || (videoId && (!expectedId || url.searchParams.get("v") !== expectedId))
      ) {
        return null;
      }
      return url;
    } catch (error) {
      return null;
    }
  }

  function normalizeCaptionTracks(playerResponse, videoId = null) {
    const raw = playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
    if (!Array.isArray(raw)) return [];
    return raw
      .map((track, index) => {
        const url = validatedCaptionUrl(track?.baseUrl, videoId);
        if (!url) return null;
        const targetLang = String(url.searchParams.get("tlang") || "");
        const name = track?.name?.simpleText
          || (Array.isArray(track?.name?.runs) ? track.name.runs.map((run) => run?.text || "").join("") : "");
        return {
          id: String(track?.vssId || track?.languageCode || index),
          lang: String(track?.languageCode || ""),
          targetLang,
          effectiveLang: targetLang || String(track?.languageCode || ""),
          langLabel: String(name || track?.languageCode || ""),
          url: url.toString(),
          // kind=asr 是 YouTube 自己生成的自动字幕；它仍属于官方字幕轨，
          // 但展示时标记出来，让用户知道不是创作者手工上传的轨道。
          isAi: String(track?.kind || "") === "asr"
            || url.searchParams.get("caps") === "asr",
        };
      })
      .filter(Boolean);
  }

  function captionTrackFromUrl(trackUrl, videoId) {
    try {
      const expectedId = parseVideoId(videoId);
      const url = expectedId ? validatedCaptionUrl(trackUrl, expectedId) : null;
      if (!url) return null;
      const lang = String(url.searchParams.get("lang") || "");
      return {
        id: String(url.searchParams.get("vssId") || lang || "captured"),
        lang,
        targetLang: String(url.searchParams.get("tlang") || ""),
        effectiveLang: String(url.searchParams.get("tlang") || lang || ""),
        langLabel: String(url.searchParams.get("name") || lang || "YouTube 字幕"),
        url: url.toString(),
        isAi: url.searchParams.get("kind") === "asr"
          || url.searchParams.get("caps") === "asr",
      };
    } catch (error) {
      return null;
    }
  }

  function pickCaptionTrack(tracks, preference = DEFAULT_LANG_PREFERENCE) {
    if (!Array.isArray(tracks) || !tracks.length) return null;
    const preferred = Array.isArray(preference) ? preference : DEFAULT_LANG_PREFERENCE;
    const rank = (track) => {
      const language = track.effectiveLang || track.lang;
      const exact = preferred.indexOf(language);
      if (exact >= 0) return exact;
      const prefix = preferred.findIndex((lang) => language.startsWith(`${lang}-`) || lang.startsWith(`${language}-`));
      return prefix >= 0 ? preferred.length + prefix : preferred.length * 2;
    };
    return [...tracks].sort((left, right) => {
      const byLanguage = rank(left) - rank(right);
      return byLanguage || Number(left.isAi) - Number(right.isAi);
    })[0];
  }

  function decodeXml(text) {
    return String(text || "")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;|&apos;/g, "'");
  }

  function normalizeJson3(payload) {
    const events = Array.isArray(payload?.events) ? payload.events : [];
    return events
      .map((event, index) => {
        const text = Array.isArray(event?.segs)
          ? event.segs.map((segment) => segment?.utf8 || "").join("").replace(/\s+/g, " ").trim()
          : "";
        if (!text) return null;
        const start = Math.max(0, Number(event?.tStartMs) / 1000 || 0);
        const explicitDuration = Math.max(0, Number(event?.dDurationMs) / 1000 || 0);
        const nextStart = Number(events[index + 1]?.tStartMs) / 1000;
        const duration = explicitDuration || (Number.isFinite(nextStart) && nextStart > start ? nextStart - start : 0.01);
        return { text, start, duration };
      })
      .filter(Boolean);
  }

  function normalizeXml(text) {
    const entries = [];
    const pattern = /<text\b([^>]*)>([\s\S]*?)<\/text>/gi;
    for (const match of String(text || "").matchAll(pattern)) {
      const attrs = match[1] || "";
      const get = (name) => attrs.match(new RegExp(`${name}=["']([^"']*)["']`, "i"))?.[1];
      const value = decodeXml(match[2]).replace(/<br\s*\/?>(\s*)/gi, "\n$1").trim();
      if (!value) continue;
      const start = Math.max(0, Number(get("start")) || 0);
      const duration = Math.max(0.01, Number(get("dur")) || 0.01);
      entries.push({ text: value, start, duration });
    }
    return entries;
  }

  function parseCaptionTrackContent(body, contentType = "") {
    const text = String(body || "");
    if (!text.trim()) return [];
    const type = String(contentType || "").toLowerCase();
    if (type.includes("json") || /^[\s\uFEFF]*[\[{]/.test(text)) {
      try {
        return normalizeJson3(JSON.parse(text));
      } catch (error) {
        if (type.includes("json")) return [];
      }
    }
    return normalizeXml(text);
  }

  async function fetchCaptionTrackContent(trackUrl, { fetchImpl = fetch } = {}) {
    let url;
    try {
      url = new URL(trackUrl);
      if (!url.searchParams.has("fmt")) url.searchParams.set("fmt", "json3");
    } catch (error) {
      throw new YoutubeApiError("INVALID_CAPTION_URL", "YouTube 字幕地址无效。");
    }
    const response = await fetchImpl(url.toString(), { credentials: "include" });
    if (!response.ok) {
      throw new YoutubeApiError("SUBTITLE_DOWNLOAD_FAILED", `YouTube 字幕下载失败：HTTP ${response.status}`);
    }
    const body = await response.text();
    const type = String(response.headers?.get?.("content-type") || "");
    return parseCaptionTrackContent(body, type);
  }

  function normalizeVideoInfo(playerResponse, videoId, url = "", fallback = {}) {
    const details = playerResponse?.videoDetails || {};
    return {
      platform: "youtube",
      videoId,
      bvid: "",
      title: String(details.title || fallback.title || "").trim(),
      owner: String(details.author || fallback.owner || "").trim(),
      description: String(details.shortDescription || fallback.description || "").trim(),
      duration: Number(details.lengthSeconds) || Number(fallback.duration) || 0,
      page: 1,
      url: String(url || `https://www.youtube.com/watch?v=${videoId}`),
    };
  }

  return {
    DEFAULT_LANG_PREFERENCE,
    YoutubeApiError,
    parseVideoId,
    normalizeCaptionTracks,
    captionTrackFromUrl,
    pickCaptionTrack,
    normalizeJson3,
    normalizeXml,
    parseCaptionTrackContent,
    fetchCaptionTrackContent,
    normalizeVideoInfo,
  };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = VIDEO_DIGEST_YOUTUBE;
}
