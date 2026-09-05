/**
 * Supadata YouTube 原生字幕适配器。
 *
 * 这是 youtube-digest 上游使用的字幕来源：只请求已经存在的原生字幕，
 * 不允许服务商退回 AI 生成字幕。网络请求由 service worker 发起，API key
 * 只放在请求头中，不出现在 URL、日志或缓存结果里。
 */
var VIDEO_DIGEST_SUPADATA = (() => {
  const TRANSCRIPT_URL = "https://api.supadata.ai/v1/transcript";
  const DEFAULT_LANGUAGE = "en";
  const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;

  class SupadataApiError extends Error {
    constructor(code, message, status = 0) {
      super(message);
      this.name = "SupadataApiError";
      this.code = code;
      this.status = status;
    }
  }

  function normalizeVideoId(value) {
    const text = String(value || "").trim();
    if (VIDEO_ID_PATTERN.test(text)) return text;
    try {
      const url = new URL(text);
      if (url.hostname.toLowerCase().replace(/^www\./, "") !== "youtube.com") {
        return null;
      }
      const id = url.searchParams.get("v") || "";
      return VIDEO_ID_PATTERN.test(id) ? id : null;
    } catch (error) {
      return null;
    }
  }

  function normalizeLanguage(value) {
    const text = String(value || "").trim().replace(/_/g, "-");
    const base = text.split("-")[0].toLowerCase();
    return /^[a-z]{2}$/.test(base) ? base : DEFAULT_LANGUAGE;
  }

  function canonicalVideoUrl(videoId) {
    const id = normalizeVideoId(videoId);
    if (!id) {
      throw new SupadataApiError("INVALID_VIDEO_ID", "YouTube 视频地址无效。");
    }
    return `https://www.youtube.com/watch?v=${id}`;
  }

  function buildTranscriptUrl(videoId, { language = DEFAULT_LANGUAGE } = {}) {
    const url = new URL(TRANSCRIPT_URL);
    url.searchParams.set("url", canonicalVideoUrl(videoId));
    url.searchParams.set("text", "false");
    url.searchParams.set("lang", normalizeLanguage(language));
    url.searchParams.set("mode", "native");
    return url.toString();
  }

  function cleanText(value) {
    return String(value || "").replace(/>> ?/g, "").trim();
  }

  function numberOr(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  function parseTranscriptResponse(payload, fallbackLanguage = DEFAULT_LANGUAGE) {
    const source = payload && typeof payload === "object" ? payload : {};
    const chunks = Array.isArray(source.content)
      ? source.content
      : typeof source.content === "string"
        ? [{ text: source.content, offset: 0, duration: 0 }]
        : [];
    const entries = [];
    for (const chunk of chunks) {
      const text = cleanText(chunk?.text);
      if (!text) continue;
      const start = Math.max(
        0,
        numberOr(chunk?.offset, numberOr(chunk?.start, 0) * 1000) / 1000,
      );
      const duration = Math.max(
        0.01,
        numberOr(chunk?.duration, 0) / 1000,
      );
      entries.push({ text, start, duration });
    }
    return {
      entries,
      language: String(source.lang || fallbackLanguage || DEFAULT_LANGUAGE).trim(),
      availableLanguages: Array.isArray(source.availableLangs)
        ? source.availableLangs.map((value) => String(value || "").trim()).filter(Boolean)
        : [],
    };
  }

  async function readJson(response) {
    try {
      return await response.json();
    } catch (error) {
      return {};
    }
  }

  function errorFromResponse(response, data, prefix = "Supadata 字幕请求失败") {
    const status = Number(response?.status) || 0;
    const message = String(data?.message || data?.error || "").trim();
    if (status === 401) {
      return new SupadataApiError(
        "INVALID_SUPADATA_KEY",
        "Supadata API 密钥无效，请到设置页检查。",
        status,
      );
    }
    if (status === 404 || status === 206) {
      return new SupadataApiError(
        "NO_TRANSCRIPT",
        "Supadata 没有找到这个视频的原生字幕。",
        status,
      );
    }
    if (status === 429) {
      return new SupadataApiError(
        "SUPADATA_RATE_LIMITED",
        "Supadata 请求次数已达到限制，请稍后重试。",
        status,
      );
    }
    return new SupadataApiError(
      "SUPADATA_REQUEST_FAILED",
      message ? `${prefix}：${message}` : `${prefix}：HTTP ${status || "未知错误"}`,
      status,
    );
  }

  async function fetchTranscript(
    videoId,
    {
      apiKey,
      language = DEFAULT_LANGUAGE,
      fetchImpl = globalThis.fetch,
      pollIntervalMs = 1000,
      maxAttempts = 60,
    } = {},
  ) {
    const id = normalizeVideoId(videoId);
    if (!id) throw new SupadataApiError("INVALID_VIDEO_ID", "YouTube 视频地址无效。");
    const key = String(apiKey || "").trim();
    if (!key) throw new SupadataApiError("NO_SUPADATA_KEY", "未配置 Supadata API 密钥。");
    if (typeof fetchImpl !== "function") {
      throw new SupadataApiError("SUPADATA_FETCH_UNAVAILABLE", "当前环境无法请求 Supadata。");
    }

    const headers = { "x-api-key": key };
    const response = await fetchImpl(buildTranscriptUrl(id, { language }), {
      method: "GET",
      headers,
    });
    let data = await readJson(response);
    if (Number(response?.status) === 202) {
      const jobId = String(data?.jobId || "").trim();
      if (!jobId) {
        throw new SupadataApiError("SUPADATA_INVALID_JOB", "Supadata 没有返回有效的字幕任务。");
      }
      for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        if (pollIntervalMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
        }
        const pollResponse = await fetchImpl(
          `${TRANSCRIPT_URL}/${encodeURIComponent(jobId)}`,
          { method: "GET", headers },
        );
        data = await readJson(pollResponse);
        if (!pollResponse.ok) throw errorFromResponse(pollResponse, data, "Supadata 字幕任务失败");
        if (data?.status === "completed") break;
        if (data?.status === "failed") {
          throw new SupadataApiError(
            "SUPADATA_JOB_FAILED",
            String(data.error || data.message || "Supadata 字幕任务失败"),
          );
        }
        if (attempt === maxAttempts - 1) {
          throw new SupadataApiError("SUPADATA_JOB_TIMEOUT", "Supadata 字幕任务处理超时。");
        }
      }
    } else if (Number(response?.status) === 206) {
      throw errorFromResponse(response, data);
    } else if (!response.ok) {
      throw errorFromResponse(response, data);
    }

    const result = parseTranscriptResponse(data, normalizeLanguage(language));
    if (!result.entries.length) {
      throw new SupadataApiError("EMPTY_TRANSCRIPT", "Supadata 返回了空的原生字幕。");
    }
    return result;
  }

  return {
    TRANSCRIPT_URL,
    DEFAULT_LANGUAGE,
    SupadataApiError,
    normalizeVideoId,
    normalizeLanguage,
    canonicalVideoUrl,
    buildTranscriptUrl,
    parseTranscriptResponse,
    fetchTranscript,
  };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = VIDEO_DIGEST_SUPADATA;
}
