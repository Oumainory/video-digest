/**
 * 桌面伴生软件的发行信息。
 *
 * 商店里的扩展不能把 exe 直接作为安装文件静默塞进浏览器，因此正式发布
 * 时由打包流程把 DOWNLOAD_URL 配成官方安装包下载页。源码和开发包保持空值，
 * 这样未配置发行地址时会明确提示，而不会把用户送到未知站点。
 */
var BILI_COMPANION_RELEASE = (() => {
  const VERSION = "0.1.0";
  const DOWNLOAD_URL = "";

  function hasDownloadUrl() {
    try {
      const value = new URL(DOWNLOAD_URL);
      return value.protocol === "https:";
    } catch (error) {
      return false;
    }
  }

  return Object.freeze({ VERSION, DOWNLOAD_URL, hasDownloadUrl });
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = BILI_COMPANION_RELEASE;
}
