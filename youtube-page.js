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
  const CAPTION_REQUEST_EVENT = "video-digest:request-page-caption";
  const CAPTION_RESPONSE_EVENT = "video-digest:page-caption";
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

  function responseBody(xhr) {
    try {
      const responseType = String(xhr.responseType || "");
      if (!responseType || responseType === "text") return xhr.responseText || "";
      if (responseType === "json") {
        const value = xhr.response;
        return typeof value === "string" ? value : JSON.stringify(value ?? "");
      }
    } catch (error) {
      // 某些响应类型读取时会抛异常；只跳过正文捕获，不影响播放器请求。
    }
    return "";
  }

  async function fetchCaptionBodyInPage(trackUrl, id) {
    const parsedRequest = captionRequestUrl(trackUrl);
    if (!parsedRequest || parsedRequest.videoId !== id || typeof globalThis.fetch !== "function") return null;
    const candidates = [parsedRequest.url];
    if (parsedRequest.url.searchParams.get("fmt") !== "json3") {
      const json3 = new URL(parsedRequest.url);
      json3.searchParams.set("fmt", "json3");
      candidates.push(json3);
    }
    for (const url of candidates) {
      try {
        const response = await globalThis.fetch(url.toString(), {
          credentials: "include",
          cache: "no-store",
        });
        if (!response?.ok) continue;
        const body = await response.text();
        if (!body.trim() || body.length > MAX_CAPTURED_BODY_CHARS) continue;
        const contentType = String(response.headers?.get?.("content-type") || "");
        rememberCaptionBody(url.toString(), body, contentType);
        return { url: url.toString(), body, contentType };
      } catch (error) {
        // 尝试下一种格式；页面脚本不能把字幕请求异常传给播放器。
      }
    }
    return null;
  }

  function rememberExistingCaptionRequests() {
    try {
      const entries = globalThis.performance?.getEntriesByType?.("resource") || [];
      for (const entry of entries) rememberCaptionUrl(entry?.name);
    } catch (error) {
      // Resource Timing 在隐私设置下可能不可用。
    }
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
          const body = responseBody(this);
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

  function currentCaptionTrack() {
    const player = document.getElementById("movie_player");
    if (typeof player?.getOption !== "function") return null;
    try {
      const track = player.getOption("captions", "track");
      if (!track || typeof track !== "object") return null;
      return {
        languageCode: String(track.languageCode || ""),
        tlang: String(track.tlang || ""),
        kind: String(track.kind || ""),
        vssId: String(track.vssId || ""),
      };
    } catch (error) {
      // 播放器切换字幕轨时 getOption 可能短暂不可用。
      return null;
    }
  }

  function currentCaptionTrackUrl(playerResponse, activeTrack) {
    if (!activeTrack) return "";
    const activeLanguage = String(activeTrack.tlang || activeTrack.languageCode || "");
    const activeKind = String(activeTrack.kind || "");
    const capturedUrl = [...(capturedCaptionUrls.get(currentVideoId()) || [])].reverse().find((value) => {
      try {
        const url = new URL(value, location.href);
        const language = String(url.searchParams.get("tlang") || url.searchParams.get("lang") || "");
        const sameLanguage = activeLanguage && (
          language === activeLanguage
          || language.startsWith(`${activeLanguage}-`)
          || activeLanguage.startsWith(`${language}-`)
        );
        const isAi = url.searchParams.get("kind") === "asr"
          || url.searchParams.get("caps") === "asr";
        const sameKind = !activeKind || (activeKind === "asr") === isAi;
        return sameKind && sameLanguage;
      } catch (error) {
        return false;
      }
    });
    if (capturedUrl) return capturedUrl;
    const tracks = playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
    if (!Array.isArray(tracks)) return "";
    const activeVssId = String(activeTrack.vssId || "");
    const match = tracks.find((track) => {
      const sameVssId = activeVssId && String(track?.vssId || "") === activeVssId;
      const language = String(track?.languageCode || "");
      const sameLanguage = activeLanguage && (
        language === activeLanguage
        || language.startsWith(`${activeLanguage}-`)
        || activeLanguage.startsWith(`${language}-`)
      );
      let trackIsAi = String(track?.kind || "") === "asr";
      try {
        trackIsAi ||= new URL(String(track?.baseUrl || ""), location.href)
          .searchParams.get("caps") === "asr";
      } catch (error) {}
      const sameKind = !activeKind || (activeKind === "asr") === trackIsAi;
      return sameKind && (sameVssId || sameLanguage);
    });
    return String(match?.baseUrl || "");
  }

  document.addEventListener(CAPTION_REQUEST_EVENT, (event) => {
    let request = null;
    try { request = JSON.parse(String(event.detail || "")); } catch (error) {}
    const id = currentVideoId();
    if (!request?.requestId || request.videoId !== id) return;
    const respond = (caption) => {
      document.dispatchEvent(new CustomEvent(CAPTION_RESPONSE_EVENT, {
        detail: JSON.stringify({
          requestId: String(request.requestId),
          videoId: id,
          caption,
        }),
      }));
    };
    void fetchCaptionBodyInPage(request.trackUrl, id)
      .then(respond)
      .catch(() => respond(null));
  });

  document.addEventListener(REQUEST_EVENT, (event) => {
    const requestId = String(event.detail || "");
    const videoId = currentVideoId();
    rememberExistingCaptionRequests();
    let playerResponse = null;
    try {
      playerResponse = videoId ? currentPlayerResponse(videoId) : null;
    } catch (error) {
      // YouTube 正在替换播放器对象时内部 getter 可能短暂不可用。
    }
    const activeCaptionTrack = currentCaptionTrack();
    document.dispatchEvent(new CustomEvent(RESPONSE_EVENT, {
      detail: JSON.stringify({
        requestId,
        videoId,
        playerResponse,
        activeCaptionTrack,
        activeCaptionTrackUrl: currentCaptionTrackUrl(playerResponse, activeCaptionTrack),
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
