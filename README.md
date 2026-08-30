# Video Digest

Video Digest 是一款面向视频学习的浏览器扩展与 Windows 桌面伴生程序。扩展负责读取 Bilibili 和 YouTube 提供的官方字幕；本地视频和音频识别交给桌面程序，在本机完成 OCR/ASR、字幕编辑、导出和后续学习功能。

> 项目状态：扩展主链路和伴生程序框架已完成。OCR/ASR 引擎以独立构建产物形式提供，不把模型和大型二进制文件提交到 Git 仓库。

## 功能

- Bilibili / YouTube 官方字幕读取、搜索、时间戳跳转和双语展示
- 视频学习总结、问答、划词解释和时间戳笔记
- 本地音频 ASR
- 本地视频硬字幕 OCR
- 视频播放器中的字幕区域拖动、缩放和位置预设
- OCR + ASR 双轨识别
- SRT、ASS、VTT 导出和结果编辑
- 模型按需下载、校验、卸载和本地缓存
- Windows 桌面伴生程序通过 Chrome/Edge Native Messaging 与扩展通信
- 用户不需要安装 Python、Node.js 或 FFmpeg

## 产品边界

扩展不会对网页视频执行 OCR/ASR，也不会通过网页抓取视频音频。在线平台只使用平台官方字幕；本地文件识别通过用户主动打开的桌面伴生程序执行。

```text
浏览器扩展
  ├─ Bilibili / YouTube 官方字幕
  ├─ 阅读、问答、总结、笔记
  └─ Native Messaging
       ↓
Windows 桌面伴生程序
  ├─ 播放视频并调整字幕区域
  ├─ 管理模型和任务
  └─ JSONL 引擎协议
       ↓
独立 OCR/ASR 引擎
  ├─ OCR：VideOCR 流程 + PaddleOCR 本地后端
  └─ ASR：whisper.cpp
```

## 普通用户安装

正式发布后，用户只需要：

1. 从 Chrome Web Store 或 Edge Add-ons 安装扩展。
2. 在扩展的本地识别卡片中下载 Windows 伴生程序。
3. 安装伴生程序并重新打开扩展。
4. 首次使用本地识别时下载 OCR 或 ASR 模型。

伴生程序安装包和模型包发布在本仓库的 [GitHub Releases](https://github.com/Oumainory/video-digest/releases)，不需要下载或克隆整个源代码仓库。

## 开发环境

扩展本身是无构建步骤的 Manifest V3 项目。运行测试：

```powershell
npm test
npm run check
```

生成扩展 ZIP：

```powershell
npm run package:windows
```

本地运行桌面伴生程序：

```powershell
npm install --prefix companion
npm start --prefix companion
```

桌面程序没有引擎输入时仍可以打开播放器、模型管理和历史记录界面；开始识别需要真实的引擎目录和模型清单。

## 构建 Windows 伴生程序

发布构建需要以下输入：

- 已构建的 `video-digest-engine.exe`；
- `whisper-cli.exe`、OCR CLI/运行文件和随包提供的 FFmpeg；
- 真实模型清单，包含 HTTPS 地址、版本、大小和 SHA-256；
- Chrome 和 Edge 发布后的扩展 ID。

环境变量示例：

```powershell
$env:VIDEO_DIGEST_CHROME_EXTENSION_ID = "正式 Chrome 扩展 ID"
$env:VIDEO_DIGEST_EDGE_EXTENSION_ID = "正式 Edge 扩展 ID"
$env:VIDEO_DIGEST_ENGINE_DIR = "D:\release\video-digest-engine"
$env:VIDEO_DIGEST_MODEL_SOURCES_FILE = "D:\release\model-sources.json"
npm run dist --prefix companion
```

扩展包中的桌面程序下载地址在发布构建时注入：

```powershell
$env:VIDEO_DIGEST_COMPANION_DOWNLOAD_URL = "https://github.com/Oumainory/video-digest/releases/latest/download/Video-Digest-Companion-Setup.exe"
npm run package:windows
```

没有真实引擎、模型地址或扩展 ID 时，发布构建会失败，而不是生成一个安装后无法识别的假安装包。

## 引擎选型

### OCR

首选 OCR 方案是 VideOCR 的视频字幕处理流程和 CLI 适配方式，底层采用 PaddleOCR 的本地推理后端。VideOCR 与本项目的需求高度重合：视频时间轴定位、字幕裁剪区域、硬字幕识别、SRT 输出和 Windows 独立发布。

本项目不使用 VideOCR 的 Google Lens 云端模式。VideOCR 原生输出 SRT，因此 `engine-src` 中的适配器会把它转换为 Video Digest 的 JSONL `progress/result` 协议，并把扩展传入的 `0..1` 归一化区域转换为像素坐标。

### ASR

ASR 使用 whisper.cpp。它是原生 C/C++ 实现，支持 Windows、CPU、多种 GPU 后端以及 JSON/SRT/VTT 输出。适配器负责处理音视频输入、模型路径、进度、取消和统一字幕结构。

## 引擎源码与发布产物

```text
engine-src/
└─ video-digest-engine/
   ├─ adapter/       # VideOCR/PaddleOCR 与 whisper.cpp 适配器
   ├─ protocol/      # JSONL-v1 协议
   ├─ ocr/
   ├─ asr/
   ├─ licenses/
   └─ README.md
```

引擎目录是发布构建输入，不应提交模型、视频、音频或大型二进制文件。模型使用压缩包或单文件下载，安装后存放在用户数据目录，并通过 SHA-256 校验。

## 目录说明

- `manifest.json`：浏览器扩展清单
- `sidepanel.*`、`background.js`、`content.js`：扩展界面和平台接入
- `lib/companion-*`：扩展与桌面程序的通信协议
- `companion/`：Electron 桌面伴生程序
- `engine-src/`：OCR/ASR 适配器源码和构建脚本
- `prompts/`：总结、问答、翻译和笔记提示词
- `tests/`：扩展、协议、模型和桌面程序测试
- `THIRD-PARTY-NOTICES`：第三方代码、引擎、模型和依赖的版权说明

## 隐私

本地视频、音频、OCR/ASR 结果和模型默认保存在本机。扩展的 AI 功能是否向用户配置的模型服务发送字幕或问题，取决于用户主动配置的服务；本地 OCR/ASR 引擎不要求上传媒体文件。

## 许可证与致谢

本项目原创代码和修改部分使用 MIT License，版权归 Oumainory。项目借鉴了：

- [youtube-digest](https://github.com/zarazhangrui/youtube-digest)，MIT，Copyright (c) 2026 Zara Zhang；
- [biuworks/bilibili-digest](https://github.com/biuworks/bilibili-digest)，MIT，Copyright (c) 2026 k1234567；
- [VideOCR](https://github.com/timminator/VideOCR)，MIT；
- [PaddleOCR](https://github.com/PaddlePaddle/PaddleOCR)，Apache License 2.0；
- [whisper.cpp](https://github.com/ggml-org/whisper.cpp)，MIT。

完整版权、许可证和发布时的模型/运行时清单见 [`LICENSE`](LICENSE) 和 [`THIRD-PARTY-NOTICES`](THIRD-PARTY-NOTICES)。
