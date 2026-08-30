/** 本地 OCR/ASR 结果仓储：与 B 站字幕缓存分离，但共用扩展的 IndexedDB。 */
var BILI_LOCAL_TRANSCRIPT_STORE = (() => {
  const PROTOCOL =
    typeof BILI_COMPANION !== "undefined"
      ? BILI_COMPANION
      : require("./companion-protocol.js");

  function isValid(record) {
    return Boolean(
      record &&
        typeof record === "object" &&
        String(record.sourceId || "").trim() &&
        record.tracks &&
        Object.values(record.tracks).some((track) => track?.segments?.length),
    );
  }

  function createLocalTranscriptRepository({ driver, now = Date.now() } = {}) {
    if (!driver) throw new Error("本地字幕仓储需要存储驱动。");

    const withId = (record) => ({ ...record, id: record.sourceId });
    const stripId = ({ id, ...record }) => record;

    return {
      driver,
      async all() {
        const rows = await driver.getAll();
        return rows
          .filter(isValid)
          .map(stripId)
          .sort((left, right) => Number(right.updatedAt || 0) - Number(left.updatedAt || 0));
      },
      async find(sourceId) {
        const row = await driver.get(String(sourceId || ""));
        return isValid(row) ? stripId(row) : null;
      },
      async save(input) {
        const record = PROTOCOL.normalizeTranscript(input, { now });
        await driver.write({ put: [withId(record)] });
        return record;
      },
      async remove(sourceId) {
        const id = String(sourceId || "").trim();
        if (id) await driver.write({ remove: [id] });
      },
      async clear() {
        await driver.clear();
      },
    };
  }

  return { createLocalTranscriptRepository, isValid };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = BILI_LOCAL_TRANSCRIPT_STORE;
}
