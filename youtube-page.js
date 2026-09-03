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
  const capturedCaptionBodies = new Map();
  const MAX_CAPTURED_BODY_CHARS = 2_000_000;

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

  function captionRequestUrl(value) {
    try {
      const url = new URL(String(value || ""), location.href);
      const hostname = url.hostname.toLowerCase();
      const videoId = url.searchParams.get("v") || "";
      if (
        url.protocol !== "https:"
        || !(hostname === "youtube.com" || hostname.endsWith(".youtube.com"))
        || url.pathname !== "/api/timedtext"
        || !/^[A-Za-z0-9_-]{11}$/.test(videoId)
      ) return null;
      return { url, videoId };
    } catch (error) {
      return null;
    }
  }

  function rememberCaptionBody(requestUrl, body, contentType = "") {
    const parsedRequest = captionRequestUrl(requestUrl);
    const text = String(body || "");
    if (!parsedRequest || !text.trim() || text.length > MAX_CAPTURED_BODY_CHARS) return;
    const value = {
      url: parsedRequest.url.toString(),
      body: text,
      contentType: String(contentType || ""),
    };
    const bodies = capturedCaptionBodies.get(parsedRequest.videoId) || [];
    const existing = bodies.findIndex((item) => item.url === value.url);
    if (existing >= 0) bodies.splice(existing, 1);
    bodies.push(value);
    while (bodies.length > 4) bodies.shift();
    capturedCaptionBodies.set(parsedRequest.videoId, bodies);
    rememberCaptionUrl(value.url);
  }

  // 借鉴成熟视频摘要扩展的做法：在页面脚本发起请求前观察官方字幕 URL，
  // 用于识别播放器当前实际请求的字幕轨，避免静态 player response 与活动轨不一致。
  function observeCaptionRequests() {
    if (typeof XMLHttpRequest === "undefined") return;
    const originalOpen = XMLHttpRequest.prototype.open;
    if (typeof originalOpen !== "function" || originalOpen.__videoDigestObserved) return;
    function open(...args) {
      this.__videoDigestCaptionUrl = args[1];
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

    const originalSend = XMLHttpRequest.prototype.send;
    if (typeof originalSend !== "function" || originalSend.__videoDigestObserved) return;
    function send(...args) {
      const capture = () => {
        const requestUrl = this.__videoDigestCaptionUrl || this.responseURL;
        if (this.status >= 200 && this.status < 300) {
          let body = "";
          try { body = this.responseType && this.responseType !== "text" ? "" : this.responseText; } catch (error) {}
          let contentType = "";
          try { contentType = this.getResponseHeader?.("content-type") || ""; } catch (error) {}
          rememberCaptionBody(requestUrl, body, contentType);
        }
      };
      try {
        this.addEventListener?.("load", capture, { once: true });
      } catch (error) {}
      return originalSend.apply(this, args);
    }
    try {
      Object.defineProperty(send, "__videoDigestObserved", { value: true });
      Object.defineProperty(XMLHttpRequest.prototype, "send", {
        configurable: true,
        writable: true,
        value: send,
      });
    } catch (error) {
      // 只要 URL 观察成功，静态字幕轨和页面重试仍可用。
    }
  }

  function observeFetchRequests() {
    const originalFetch = globalThis.fetch;
    if (typeof originalFetch !== "function" || originalFetch.__videoDigestObserved) return;
    const observedFetch = function (...args) {
      const input = args[0];
      const requestUrl = typeof input === "string" ? input : input?.url;
      rememberCaptionUrl(requestUrl);
      const pending = originalFetch.apply(this, args);
      return Promise.resolve(pending).then((response) => {
        if (response?.ok && typeof response.clone === "function") {
          try {
            void response.clone().text().then((body) => {
              rememberCaptionBody(
                requestUrl,
                body,
                response.headers?.get?.("content-type") || "",
              );
            }).catch(() => {});
          } catch (error) {}
        }
        return response;
      });
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
        captionBodies: capturedCaptionBodies.get(videoId) || [],
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
