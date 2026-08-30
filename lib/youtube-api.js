/**
 * YouTube 官方字幕数据源。
 *
 * 页面内容脚本只读取 YouTube 自己下发的 ytInitialPlayerResponse，字幕正文
 * 仍由 service worker 下载；扩展不会对网页视频截帧、录音或启动本地 OCR/ASR。
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
      if (hostname === "youtube.com" && url.pathname === "/watch") {
        const id = url.searchParams.get("v") || "";
        return /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
      }
    } catch (error) {
      // 裸 video id 也接受，方便内容脚本与测试直接传值。
    }
    return /^[A-Za-z0-9_-]{11}$/.test(text) ? text : null;
  }

  function normalizeCaptionTracks(playerResponse) {
    const raw = playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
    if (!Array.isArray(raw)) return [];
    return raw
      .map((track, index) => {
        const url = String(track?.baseUrl || "");
        if (!url) return null;
        const name = track?.name?.simpleText
          || (Array.isArray(track?.name?.runs) ? track.name.runs.map((run) => run?.text || "").join("") : "");
        return {
          id: String(track?.vssId || track?.languageCode || index),
          lang: String(track?.languageCode || ""),
          langLabel: String(name || track?.languageCode || ""),
          url,
          // kind=asr 是 YouTube 自己生成的自动字幕；它仍属于官方字幕轨，
          // 但展示时标记出来，让用户知道不是创作者手工上传的轨道。
          isAi: String(track?.kind || "") === "asr",
        };
      })
      .filter(Boolean);
  }

  function pickCaptionTrack(tracks, preference = DEFAULT_LANG_PREFERENCE) {
    if (!Array.isArray(tracks) || !tracks.length) return null;
    const preferred = Array.isArray(preference) ? preference : DEFAULT_LANG_PREFERENCE;
    const rank = (track) => {
      const exact = preferred.indexOf(track.lang);
      if (exact >= 0) return exact;
      const prefix = preferred.findIndex((lang) => track.lang.startsWith(`${lang}-`) || lang.startsWith(`${track.lang}-`));
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

  async function fetchCaptionTrackContent(trackUrl, { fetchImpl = fetch } = {}) {
    let url;
    try {
      url = new URL(trackUrl);
      if (!url.searchParams.has("fmt")) url.searchParams.set("fmt", "json3");
    } catch (error) {
      throw new YoutubeApiError("INVALID_CAPTION_URL", "YouTube 字幕地址无效。");
    }
    const response = await fetchImpl(url.toString(), { credentials: "omit" });
    if (!response.ok) {
      throw new YoutubeApiError("SUBTITLE_DOWNLOAD_FAILED", `YouTube 字幕下载失败：HTTP ${response.status}`);
    }
    const type = String(response.headers?.get?.("content-type") || "").toLowerCase();
    if (type.includes("json")) return normalizeJson3(await response.json());
    const body = await response.text();
    try {
      return normalizeJson3(JSON.parse(body));
    } catch (error) {
      return normalizeXml(body);
    }
  }

  function normalizeVideoInfo(playerResponse, videoId, url = "") {
    const details = playerResponse?.videoDetails || {};
    return {
      platform: "youtube",
      videoId,
      bvid: "",
      title: String(details.title || "").trim(),
      owner: String(details.author || "").trim(),
      description: String(details.shortDescription || "").trim(),
      duration: Number(details.lengthSeconds) || 0,
      page: 1,
      url: String(url || `https://www.youtube.com/watch?v=${videoId}`),
    };
  }

  return {
    DEFAULT_LANG_PREFERENCE,
    YoutubeApiError,
    parseVideoId,
    normalizeCaptionTracks,
    pickCaptionTrack,
    normalizeJson3,
    normalizeXml,
    fetchCaptionTrackContent,
    normalizeVideoInfo,
  };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = VIDEO_DIGEST_YOUTUBE;
}
