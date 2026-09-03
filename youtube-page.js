/**
 * YouTube 页面世界桥接层。
 *
 * 普通内容脚本运行在 isolated world，读不到页面上的 ytInitialPlayerResponse。
 * 这个脚本只负责在收到 DOM 事件时，把当前视频的播放器响应序列化回去；
 * 它不使用扩展 API，也不读取或传递任何用户凭据。
 */
(() => {
  "use strict";

  const REQUEST_EVENT = "video-digest:request-player-response";
  const RESPONSE_EVENT = "video-digest:player-response";
  const capturedCaptionUrls = new Map();

  function currentVideoId() {
    try {
      const value = new URL(location.href).searchParams.get("v") || "";
      return /^[A-Za-z0-9_-]{11}$/.test(value) ? value : null;
    } catch (error) {
      return null;
    }
  }

  function parsed(value) {
    if (value && typeof value === "object") return value;
    if (typeof value !== "string") return null;
    try {
      return JSON.parse(value);
    } catch (error) {
      return null;
    }
  }

  function rememberCaptionUrl(value) {
    try {
      const url = new URL(String(value || ""), location.href);
      const hostname = url.hostname.toLowerCase();
      if (
        url.protocol !== "https:"
        || !(hostname === "youtube.com" || hostname.endsWith(".youtube.com"))
        || url.pathname !== "/api/timedtext"
      ) return;
      const videoId = currentVideoId();
      const requestVideoId = url.searchParams.get("v");
      if (!videoId || requestVideoId !== videoId) return;
      const urls = capturedCaptionUrls.get(videoId) || [];
      const capturedUrl = url.toString();
      if (!urls.includes(capturedUrl)) urls.push(capturedUrl);
      while (urls.length > 16) urls.shift();
      capturedCaptionUrls.set(videoId, urls);
      // YouTube 是单页应用，限制表的大小，避免长时间浏览后无限增长。
      while (capturedCaptionUrls.size > 8) {
        capturedCaptionUrls.delete(capturedCaptionUrls.keys().next().value);
      }
    } catch (error) {
      // 只观察合法的 YouTube timedtext 请求，其它 XHR 不受影响。
    }
  }

  // 借鉴成熟视频摘要扩展的做法：在页面脚本发起请求前观察官方字幕 URL，
  // 用于识别播放器当前实际请求的字幕轨，避免静态 player response 与活动轨不一致。
  function observeCaptionRequests() {
    if (typeof XMLHttpRequest === "undefined") return;
    const originalOpen = XMLHttpRequest.prototype.open;
    if (typeof originalOpen !== "function" || originalOpen.__videoDigestObserved) return;
    function open(...args) {
      rememberCaptionUrl(args[1]);
      return originalOpen.apply(this, args);
    }
    try {
      Object.defineProperty(open, "__videoDigestObserved", { value: true });
      Object.defineProperty(XMLHttpRequest.prototype, "open", {
        configurable: true,
        writable: true,
        value: open,
      });
    } catch (error) {
      // 极少数页面会锁定原型；放弃观察即可，播放器响应路径仍然可用。
    }
  }

  function observeFetchRequests() {
    const originalFetch = globalThis.fetch;
    if (typeof originalFetch !== "function" || originalFetch.__videoDigestObserved) return;
    const observedFetch = function (...args) {
      const input = args[0];
      rememberCaptionUrl(typeof input === "string" ? input : input?.url);
      return originalFetch.apply(this, args);
    };
    try {
      Object.defineProperty(observedFetch, "__videoDigestObserved", { value: true });
      globalThis.fetch = observedFetch;
    } catch (error) {
      // 页面环境禁止替换 fetch 时，XHR 和播放器响应路径仍可用。
    }
  }

  function currentPlayerResponse(videoId) {
    const player = document.getElementById("movie_player");
    const candidates = [
      typeof player?.getPlayerResponse === "function"
        ? player.getPlayerResponse()
        : null,
      window.ytInitialPlayerResponse,
      window.ytplayer?.config?.args?.raw_player_response,
      window.ytplayer?.config?.args?.player_response,
    ];
    return candidates
      .map(parsed)
      .find((candidate) => candidate?.videoDetails?.videoId === videoId) || null;
  }

  document.addEventListener(REQUEST_EVENT, (event) => {
    const requestId = String(event.detail || "");
    const videoId = currentVideoId();
    let playerResponse = null;
    try {
      playerResponse = videoId ? currentPlayerResponse(videoId) : null;
    } catch (error) {
      // YouTube 正在替换播放器对象时内部 getter 可能短暂不可用。
    }
    document.dispatchEvent(new CustomEvent(RESPONSE_EVENT, {
      detail: JSON.stringify({
        requestId,
        videoId,
        playerResponse,
        captionTrackUrls: capturedCaptionUrls.get(videoId) || [],
        captionTrackUrl: (() => {
          const urls = capturedCaptionUrls.get(videoId) || [];
          return urls.length ? urls[urls.length - 1] : "";
        })(),
      }),
    }));
  });

  observeCaptionRequests();
  observeFetchRequests();
})();
