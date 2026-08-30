# Video Digest Companion

Video Digest Companion 是 Windows 桌面伴生程序，负责本地媒体播放、字幕区域校准、OCR/ASR 任务、模型管理和识别结果编辑。它通过 Chrome/Edge Native Messaging 与浏览器扩展通信。

普通用户不需要单独安装 Node.js、Python 或 FFmpeg；这些运行时和识别引擎由正式安装包或引擎发布包提供。

## 目录职责

- `index.html` / `renderer.js` / `app.css`：桌面界面、播放器、字幕区域框和结果编辑
- `main.cjs`：Electron 主进程、任务历史、模型状态和 IPC
- `engine.cjs`：调用统一 JSONL 识别引擎协议
- `model-store.cjs`：模型目录、下载、校验、解压、安装和卸载
- `native-host.cjs`：Chrome/Edge Native Messaging broker
- `install-host.ps1`：Windows Native Messaging 注册脚本
- `engine-src/`：识别引擎适配器源码位于仓库根目录

## JSONL 引擎协议

引擎由 `manifest.json` 指定，至少需要：

```json
{
  "executable": "video-digest-engine.exe",
  "args": ["--config", "{{configPath}}"],
  "protocol": "jsonl-v1",
  "supportsPause": true
}
```

引擎读取配置文件：

```json
{
  "filePath": "C:\\Videos\\sample.mp4",
  "mode": "both",
  "language": "",
  "region": { "x": 0.05, "y": 0.76, "width": 0.9, "height": 0.18 },
  "modelPaths": { "asr": "..." }
}
```

输出事件示例：

```text
{"type":"progress","done":35,"total":100,"phase":"ocr","message":"正在识别"}
{"type":"result","result":{"tracks":{"ocr":{"segments":[]},"asr":{"segments":[]}}}}
```

字幕时间统一使用秒，区域坐标统一使用 `0..1`。引擎必须在失败时使用非零退出码，并将可读错误写入 stderr。

## 本地开发

```powershell
npm install --prefix companion
npm start --prefix companion
```

没有真实引擎时，桌面程序仍可用于检查播放器、区域框、模型界面和历史记录。真正识别需要一个包含 `manifest.json` 和 `video-digest-engine.exe` 的引擎目录。

## Windows 发布

```powershell
$env:VIDEO_DIGEST_CHROME_EXTENSION_ID = "正式 Chrome 扩展 ID"
$env:VIDEO_DIGEST_EDGE_EXTENSION_ID = "正式 Edge 扩展 ID"
$env:VIDEO_DIGEST_ENGINE_DIR = "D:\release\video-digest-engine"
$env:VIDEO_DIGEST_MODEL_SOURCES_FILE = "D:\release\model-sources.json"
npm run dist --prefix companion
```

发布输入不包含在源代码仓库中。引擎目录必须包含真实 OCR/ASR 可执行文件、FFmpeg（如使用）及其许可证文件；模型清单必须使用 HTTPS 和 SHA-256。

## 许可证

伴生程序的原创代码使用仓库根目录的 MIT License。第三方引擎、模型、FFmpeg 和运行时的许可证必须随发布包放在可访问的许可证目录中，具体清单见仓库根目录的 `THIRD-PARTY-NOTICES`。
