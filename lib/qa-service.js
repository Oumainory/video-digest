/**
 * 视频问答服务：检索（lib/qa-retrieval.js）→ 生成 → 引用校验
 * （lib/qa-citations.js）→ 历史落库。
 *
 * 同一视频的大模型问答按多轮对话回喂；定位字幕模式是本地检索结果，
 * 不混进模型上下文。历史消息保持原来的顺序和内容，支持前缀缓存的
 * 服务商可以复用前几轮的上下文。
 */
var BILI_QA_SERVICE = (() => {
  const AI = typeof BILI_AI !== "undefined" ? BILI_AI : require("./ai.js");
  const API =
    typeof BILI_API !== "undefined" ? BILI_API : require("./bili-api.js");
  const LEARNING_STORE =
    typeof BILI_LEARNING_STORE !== "undefined"
      ? BILI_LEARNING_STORE
      : require("./learning-store.js");
  const SETTINGS =
    typeof BILI_SETTINGS !== "undefined"
      ? BILI_SETTINGS
      : require("../settings.js");
  const RETRIEVAL =
    typeof BILI_QA_RETRIEVAL !== "undefined"
      ? BILI_QA_RETRIEVAL
      : require("./qa-retrieval.js");
  const CITATIONS =
    typeof BILI_QA_CITATIONS !== "undefined"
      ? BILI_QA_CITATIONS
      : require("./qa-citations.js");
  const parseSourceId = API.parseSourceId || API.parseBvid;

  /** 历史记录的仓储：与笔记同模式，按条增删，最新在前。 */
  function createQaRepository({ driver }) {
    if (!driver) throw new Error("问答仓储需要存储驱动");
    const isValid = (record) =>
      Boolean(
        record &&
          typeof record === "object" &&
          String(record.id || "").startsWith("qa_"),
      );
    return {
      async all() {
        const rows = await driver.getAll();
        return rows
          .filter(isValid)
          .sort((a, b) => (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0));
      },
      async find(id) {
        const row = await driver.get(id);
        return isValid(row) ? row : null;
      },
      async save(record) {
        await driver.write({ put: [record] });
      },
      async remove(id) {
        await driver.write({ remove: [id] });
      },
    };
  }

  // 宽泛问题允许完整梳理视频，但仍限制输出，避免侧边栏出现无边界长文。
  const ANSWER_MAX_TOKENS = 4096;
  // 自定义服务可能只有较小的上下文窗。正常问答会远低于此值；极端长会话
  // 只保留最近的完整轮次，避免一次请求直接超过常见模型上限。
  const CONVERSATION_MAX_CHARS = 96_000;

  function taskCanceledError() {
    const error = new Error("任务已取消。");
    error.code = "TASK_CANCELED";
    return error;
  }

  function createQaService({
    cache,
    dataReady,
    ensureTranscript,
    learningRepository,
    getSettings,
    loadPromptSection,
    repository,
    requestAiCompletion,
    aiErrorResponse,
    onTaskProgress = () => {},
    logError = () => {},
  }) {
    if (
      !cache ||
      !dataReady ||
      !ensureTranscript ||
      !learningRepository ||
      !getSettings ||
      !repository ||
      !loadPromptSection ||
      !requestAiCompletion ||
      !aiErrorResponse
    ) {
      throw new Error("问答服务缺少必要依赖");
    }

    function throwIfTaskCanceled(signal) {
      if (signal?.aborted) throw taskCanceledError();
    }

    // 零有效引用时整条替换——宁可少答，不可编造。
    const FALLBACK_ANSWER =
      "未能从字幕中找到足够的依据来回答这个问题。" +
      "可以换个说法再问一次，或先确认这个视频里是否有你想问的内容。";

    function sameVideoEntries(entries, bvid, page) {
      return (Array.isArray(entries) ? entries : []).filter(
        (entry) => entry.bvid === bvid && Number(entry.page || 1) === page,
      );
    }

    function publicEntry(entry) {
      if (!entry || typeof entry !== "object") return entry;
      const { llmUserPrompt, llmAssistantContent, ...visible } = entry;
      return visible;
    }

    function conversationMessages(entries) {
      const turns = entries
        // 分模式之前保存的历史没有 mode；它们本来就是大模型回答。
        .filter((entry) => entry.mode !== "locate" && entry.answer)
        .sort((a, b) => (Number(a.createdAt) || 0) - (Number(b.createdAt) || 0))
        .map((entry) => {
          const user = String(
            entry.llmUserPrompt || `用户之前的问题：\n${entry.question || ""}`,
          );
          const assistant = String(
            entry.llmAssistantContent || JSON.stringify({ answer: entry.answer }),
          );
          return { user, assistant, size: user.length + assistant.length };
        });

      const kept = [];
      let used = 0;
      for (let index = turns.length - 1; index >= 0; index -= 1) {
        const turn = turns[index];
        if (used + turn.size > CONVERSATION_MAX_CHARS && kept.length) break;
        kept.push(turn);
        used += turn.size;
      }
      kept.reverse();

      const messages = [];
      for (const [index, turn] of kept.entries()) {
        messages.push({ role: "user", content: turn.user });
        messages.push({
          role: "assistant",
          content: turn.assistant,
          // Anthropic 最多接受有限个缓存断点。固定标记最早四轮，后续请求
          // 不会把旧标记挪走，已建立的前缀才能持续命中。
          ...(index < 4 ? { cacheControl: true } : {}),
        });
      }
      return messages;
    }

    async function askQuestion({
      bvid: bvidInput,
      page = 1,
      question,
      mode = "answer",
      signal,
      taskId,
    } = {}) {
      const bvid = parseSourceId(bvidInput);
      const text = String(question || "").trim();
      if (!bvid) {
        return { success: false, error: "INVALID_BVID", message: "没有识别到 BV 号。" };
      }
      if (!text) {
        return { success: false, error: "EMPTY_QUESTION", message: "先输入问题。" };
      }
      if (text.length > 500) {
        return {
          success: false,
          error: "QUESTION_TOO_LONG",
          message: "问题不能超过 500 个字符。",
        };
      }
      const pageNumber = Number(page) > 0 ? Math.floor(Number(page)) : 1;

      try {
        throwIfTaskCanceled(signal);
        onTaskProgress(taskId, { phase: "generating", message: "正在检索相关内容…" });

        // segments 来自缓存优先的字幕管线：重复提问不发新请求。
        const transcript = await ensureTranscript(bvid, pageNumber);
        if (!transcript.success) return transcript;

        await dataReady();
        const record = await LEARNING_STORE.loadLearningRecord(bvid, pageNumber, {
          repository: learningRepository(),
        });
        const chapters = Array.isArray(record?.analysis?.chapters)
          ? record.analysis.chapters
          : [];

        const settings = await getSettings();
        const chunks = AI.planAnalysisChunks(
          transcript.segments,
          SETTINGS.analysisChunkOptions(settings),
        );

        const context = RETRIEVAL.selectContext({
          chunks,
          question: text,
          chapters,
          totalDurationSeconds: Math.floor(
            Number(transcript.videoInfo?.duration) || 0,
          ),
        });
        if (!context.chunks.length) {
          return { success: false, error: "NO_TRANSCRIPT", message: "没有可用的字幕。" };
        }

        if (mode === "locate") {
          const matches = RETRIEVAL.findRelevantChunks(chunks, text, { chapters });
          if (!matches.length) {
            return saveEntry({
              bvid,
              page: pageNumber,
              question: text,
              mode: "locate",
              answer: "字幕中未找到与这个问题直接相关的片段。",
              citations: [],
              clickable: [],
            });
          }
          // chunk.text 已经包含原字幕行的时间戳；直接拼接，避免出现
          // `[12:34] [12:34] 原文` 这种重复标记。引用仍由本地原字幕生成。
          const answer = matches.map((chunk) => chunk.text).join("\n\n");
          const citations = CITATIONS.buildCitationsFromAnswer(
            answer,
            transcript.transcript,
            null,
          );
          return saveEntry({
            bvid,
            page: pageNumber,
            question: text,
            mode: "locate",
            answer,
            citations,
            clickable: [...CITATIONS.clickableTimestamps(answer, null)],
          });
        }
        const contextText = context.chunks.map((chunk) => chunk.text).join("\n\n");

        onTaskProgress(taskId, { phase: "generating", message: "正在组织回答…" });
        const variables = {
          videoTitle: transcript.videoInfo?.title || "未知",
          ownerName: transcript.videoInfo?.owner || "未知",
          question: text,
          transcriptText: contextText,
        };
        const [systemPrompt, userPrompt] = await Promise.all([
          loadPromptSection("qa.md", "系统提示词", variables),
          loadPromptSection("qa.md", "用户提示词", variables),
        ]);

        const qaHistory = sameVideoEntries(
          await (await repository()).all(),
          bvid,
          pageNumber,
        );
        const priorMessages = conversationMessages(qaHistory);

        const { text: raw } = await requestAiCompletion({
          maxTokens: ANSWER_MAX_TOKENS,
          responseFormat: { type: "json_object" },
          signal,
          messages: [
            { role: "system", content: systemPrompt },
            ...priorMessages,
            { role: "user", content: userPrompt },
          ],
        });
        throwIfTaskCanceled(signal);

        const parsed = AI.parseLooseJson(raw);
        // 模型偶尔会把整个回答当引语用各种引号包住，统一剥掉。
        let answer = CITATIONS.stripWrappingQuotes(
          typeof parsed?.answer === "string" ? parsed.answer : "",
        );

        // 依据原句由本地从字幕提取：模型只负责在正文里标 [分:秒]，
        // 引用内容想编造都没有载体，也不再花输出 token 摘录原句。
        const citations = CITATIONS.buildCitationsFromAnswer(
          answer,
          transcript.transcript,
          context.timeRange,
        );
        if (!answer) {
          answer = FALLBACK_ANSWER;
        } else if (!citations.length) {
          // 正文里没有任何落在字幕范围内的引用：视为没有依据。
          answer = FALLBACK_ANSWER;
        }

        // clickable 一并入库：历史卡片渲染时才知道哪些时间戳可点。
        return saveEntry({
          bvid,
          page: pageNumber,
          question: text,
          mode: "answer",
          answer,
          citations,
          clickable: [...CITATIONS.clickableTimestamps(answer, context.timeRange)],
          llmUserPrompt: userPrompt,
          llmAssistantContent: JSON.stringify({ answer }),
        });
      } catch (error) {
        logError("[Bilibili Digest] 问答失败：", error);
        return aiErrorResponse(error);
      }
    }

    async function saveEntry({
      bvid,
      page,
      question,
      mode,
      answer,
      citations,
      clickable,
      llmUserPrompt,
      llmAssistantContent,
    }) {
      const entry = {
          id: `qa_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          bvid,
          page,
          question,
          mode,
          answer,
          citations,
          clickable,
          createdAt: Date.now(),
      };
      if (mode === "answer") {
        entry.llmUserPrompt = String(llmUserPrompt || "");
        entry.llmAssistantContent = String(llmAssistantContent || "");
      }
      await dataReady();
      const history = await repository();
      await history.save(entry);
      return { success: true, entry: publicEntry(entry), retrievalMode: mode };
    }

    async function getQaHistory(bvidInput, page) {
      await dataReady();
      const bvid = parseSourceId(bvidInput);
      if (!bvid) return { success: true, entries: [] };
      const pageNumber = Number(page) > 0 ? Math.floor(Number(page)) : 1;
      const entries = sameVideoEntries(
        await (await repository()).all(),
        bvid,
        pageNumber,
      ).map(publicEntry);
      return { success: true, entries };
    }

    async function deleteQaEntry(id) {
      await dataReady();
      await (await repository()).remove(String(id || ""));
      return { success: true };
    }

    return { askQuestion, getQaHistory, deleteQaEntry };
  }

  return { createQaService, createQaRepository };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = BILI_QA_SERVICE;
}
