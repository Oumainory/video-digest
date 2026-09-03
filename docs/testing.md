# 测试与发布门禁

## 三道门禁

1. 每次提交：Linux/Windows 单元测试、覆盖率、Python 适配器和静态检查。
2. 每个 PR：Playwright 自带 Chromium 加载完整扩展；Windows 启动真正 Electron `main/preload/renderer`。
3. Tag 发布：固定哈希的真实引擎与模型、NSIS 静默安装、Native Messaging、OCR/ASR、扩展 ZIP、卸载残留；随后执行 Chrome/Edge 人工清单。

CI 不访问真实 Bilibili、YouTube 或大模型服务。浏览器 E2E 拦截官方域名并返回本地固定数据；这样既覆盖 manifest、content script、service worker、SPA 和网络解析，又不受登录、地区、灰度或费用影响。

## 命令

| 命令 | 内容 | 日常/发行 |
| --- | --- | --- |
| `npm run test:unit` | Node 单元、协议、仓储、后台、异常与安全输入 | 日常 |
| `npm run test:coverage` | 行 ≥90%、分支 ≥75%、函数 ≥85% | 日常 |
| `npm run test:e2e:extension` | B站/YouTube、侧边栏 owner、JSON3/XML、SPA | 日常 |
| `npm run test:e2e:companion` | Electron、任务控制、结果编辑、导出、重启恢复 | 日常 |
| `npm run test:engine` | Python 适配器与发行资产锁 | 日常 |
| `npm run test:engine:real` | 固定媒体的真实 OCR/ASR 阈值 | 发行 |
| `npm run test:release` | 安装、注册表、Native Messaging、真实引擎、卸载 | 发行 |
| `npm run test:all` | 所有无需大型二进制/真实账号的门禁 | 日常 |

Playwright 在 CI 失败时保留 trace、截图、视频和 HTML 报告，E2E 最多自动重试一次。Chrome/Edge 已限制命令行侧载能力，因此 CI 使用 Playwright 自带 Chromium；真实 Stable 浏览器的侧边栏外壳按 [`release-test-checklist.md`](release-test-checklist.md) 验收。

## 项目自有媒体

`tests/fixtures/engine-acceptance.mp4` 是约 10 秒的确定性测试视频，含两段烧录硬字幕和一句英文语音。源字幕、预期结果及 Windows SAPI/FFmpeg 生成脚本一并保存在仓库；修改媒体后必须同步审查预期文本和阈值。

真实引擎验收要求：两行 OCR 都出现且起始时间误差 ≤1 秒；英文 ASR WER ≤30%；双轨结果必须同时存在。发布流程还会检查暂停/恢复/取消，以及子进程和 `.tasks` 临时文件清理。

## 发行资产

VideOCR、whisper.cpp、`ggml-base` 和 FFmpeg 的版本、大小、SHA-256、许可证记录在 `engine-src/release-assets.lock.json`。仓库不保存这些大型文件。BtbN 的 `latest` 发布是可变入口，只允许人工审查后把字节完全相同的包镜像成带日期的 Video Digest Release 资产；CI 禁止直接下载 `/latest/` URL。

发布仓库需配置：

- `VIDEO_DIGEST_ENGINE_BUNDLE_URL`：版本化的自有 Release bundle URL。
- `VIDEO_DIGEST_ENGINE_BUNDLE_SHA256`：该 bundle 的 SHA-256。
- `VIDEO_DIGEST_MODEL_SOURCES_JSON`：模型来源、版本、大小、SHA 和许可证。
- Chrome/Edge 正式扩展 ID。

任何真实网站或模型行为变化都记录到人工清单，不把账号 Cookie、API Key、模型、引擎包或本机路径写入仓库和测试日志。
