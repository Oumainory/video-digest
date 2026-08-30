"""Video Digest's small JSONL adapter for the local OCR/ASR backends.

The adapter intentionally keeps the browser and Electron layers independent
from the ML implementations. A Windows release places this file's compiled
executable next to the pinned VideOCR/PaddleOCR, whisper.cpp, and FFmpeg
artifacts. End users never need to install Python.
"""

from __future__ import annotations

import argparse
import json
import os
import queue
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path
from typing import Any

try:
    import psutil  # type: ignore
except ImportError:  # pragma: no cover - optional for development-only runs
    psutil = None


PROCESS_ERRORS = (OSError,) if psutil is None else (psutil.Error, OSError)
ENGINE_ROOT = (
    Path(sys.executable).resolve().parent
    if getattr(sys, "frozen", False)
    else Path(__file__).resolve().parent
)
ACTIVE_PROCESS: subprocess.Popen[str] | None = None
CONTROL_LOCK = threading.Lock()
PAUSED = False
CANCELED = False
SUSPENDED_PIDS: set[int] = set()


class EngineError(RuntimeError):
    """An error safe to expose through the companion process stderr."""


def emit(message: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(message, ensure_ascii=False, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def emit_progress(done: int, total: int, phase: str, message: str) -> None:
    emit({"type": "progress", "done": done, "total": total, "phase": phase, "message": message})


def fail(message: str, code: int = 1) -> int:
    sys.stderr.write(f"{message}\n")
    sys.stderr.flush()
    return code


def process_tree(pid: int) -> list[Any]:
    if psutil is None:
        return []
    try:
        root = psutil.Process(pid)
        return [root, *root.children(recursive=True)]
    except (psutil.Error, OSError):
        return []


def suspend_active() -> None:
    global SUSPENDED_PIDS
    with CONTROL_LOCK:
        if ACTIVE_PROCESS is None or ACTIVE_PROCESS.poll() is not None:
            return
        for process in process_tree(ACTIVE_PROCESS.pid):
            try:
                process.suspend()
                SUSPENDED_PIDS.add(process.pid)
            except PROCESS_ERRORS:
                pass


def resume_active() -> None:
    global SUSPENDED_PIDS
    with CONTROL_LOCK:
        pids = list(SUSPENDED_PIDS)
        SUSPENDED_PIDS.clear()
    if psutil is None:
        return
    for pid in pids:
        try:
            psutil.Process(pid).resume()
        except (psutil.Error, OSError):
            pass


def terminate_active() -> None:
    with CONTROL_LOCK:
        process = ACTIVE_PROCESS
    if process is None:
        return
    children = process_tree(process.pid)
    for item in reversed(children):
        try:
            item.terminate()
        except PROCESS_ERRORS:
            pass
    try:
        process.terminate()
    except OSError:
        pass


def control_loop() -> None:
    global PAUSED, CANCELED
    for line in sys.stdin:
        try:
            message = json.loads(line)
        except json.JSONDecodeError:
            continue
        if message.get("type") != "control":
            continue
        action = str(message.get("action", "")).lower()
        if action == "pause":
            PAUSED = True
            suspend_active()
        elif action == "resume":
            PAUSED = False
            resume_active()
        elif action == "cancel":
            CANCELED = True
            terminate_active()


def path_value(value: Any, label: str) -> Path:
    result = Path(str(value or "")).expanduser()
    if not result.exists():
        raise EngineError(f"找不到{label}：{result}")
    return result.resolve()


def executable(*names: str) -> Path:
    for name in names:
        candidate = ENGINE_ROOT / name
        if candidate.is_file():
            return candidate
    raise EngineError(f"引擎目录缺少可执行文件：{'、'.join(names)}")


def run_process(command: list[str], env: dict[str, str] | None = None) -> tuple[str, str]:
    global ACTIVE_PROCESS
    try:
        process = subprocess.Popen(
            command,
            cwd=ENGINE_ROOT,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            env=env,
        )
    except OSError as error:
        raise EngineError(f"无法启动识别后端：{error}") from error
    with CONTROL_LOCK:
        ACTIVE_PROCESS = process
    if PAUSED:
        suspend_active()
    stdout, stderr = process.communicate()
    with CONTROL_LOCK:
        ACTIVE_PROCESS = None
    resume_active()
    if CANCELED:
        raise EngineError("任务已取消。")
    if process.returncode != 0:
        detail = (stderr or stdout).strip()[-4000:]
        raise EngineError(detail or f"识别后端退出码：{process.returncode}")
    return stdout, stderr


def parse_time(value: Any) -> float:
    if isinstance(value, (int, float)):
        return max(0.0, float(value))
    text = str(value or "").strip().replace(",", ".")
    if not text:
        return 0.0
    try:
        if ":" not in text:
            return max(0.0, float(text))
        parts = text.split(":")
        if len(parts) == 3:
            hours, minutes, seconds = parts
        elif len(parts) == 2:
            hours, minutes, seconds = "0", *parts
        else:
            return 0.0
        return max(0.0, int(hours) * 3600 + int(minutes) * 60 + float(seconds))
    except (ValueError, TypeError):
        return 0.0


def parse_srt(file: Path) -> list[dict[str, Any]]:
    text = file.read_text(encoding="utf-8-sig", errors="replace")
    pattern = re.compile(
        r"(?:^|\n)\s*(?:\d+\s*\n)?"
        r"(\d{1,2}:\d{2}:\d{2}[,.]\d{1,3})\s*-->\s*"
        r"(\d{1,2}:\d{2}:\d{2}[,.]\d{1,3})[^\n]*\n"
        r"(.*?)(?=\n\s*\n|\Z)",
        re.S,
    )
    segments = []
    for index, match in enumerate(pattern.finditer(text)):
        content = re.sub(r"\s+", " ", match.group(3)).strip()
        if not content:
            continue
        start = parse_time(match.group(1))
        end = max(start + 0.01, parse_time(match.group(2)))
        segments.append({"id": f"ocr-{index}-{round(start * 1000)}", "start": start, "end": end, "text": content})
    return segments


def parse_whisper_json(file: Path) -> list[dict[str, Any]]:
    value = json.loads(file.read_text(encoding="utf-8-sig", errors="replace"))
    raw_segments = value.get("segments") if isinstance(value, dict) else None
    if not isinstance(raw_segments, list) and isinstance(value, dict):
        raw_segments = value.get("transcription")
    if not isinstance(raw_segments, list):
        raw_segments = []
    segments = []
    for index, item in enumerate(raw_segments):
        if not isinstance(item, dict):
            continue
        timestamps = item.get("timestamps") if isinstance(item.get("timestamps"), dict) else {}
        offsets = item.get("offsets") if isinstance(item.get("offsets"), dict) else {}
        start = item.get("start", timestamps.get("from", offsets.get("from", 0)))
        end = item.get("end", timestamps.get("to", offsets.get("to", start)))
        if isinstance(start, (int, float)) and isinstance(end, (int, float)) and (start > 1000 or end > 1000):
            start, end = float(start) / 1000, float(end) / 1000
        text = re.sub(r"\s+", " ", str(item.get("text", item.get("content", "")))).strip()
        if not text:
            continue
        start_value = parse_time(start)
        end_value = max(start_value + 0.01, parse_time(end))
        segments.append({"id": f"asr-{index}-{round(start_value * 1000)}", "start": start_value, "end": end_value, "text": text})
    return segments


def model_file(value: Any, label: str, suffixes: tuple[str, ...]) -> Path:
    path = path_value(value, label)
    if path.is_file():
        return path
    for suffix in suffixes:
        candidates = sorted(path.rglob(f"*{suffix}"))
        if candidates:
            return candidates[0]
    raise EngineError(f"{label}目录中没有找到模型文件。")


def dimensions(config: dict[str, Any], media: Path) -> tuple[int, int]:
    width = int(config.get("videoWidth") or 0)
    height = int(config.get("videoHeight") or 0)
    if width > 0 and height > 0:
        return width, height
    ffprobe = next((candidate for candidate in (ENGINE_ROOT / "ffprobe.exe", ENGINE_ROOT / "ffprobe") if candidate.is_file()), None)
    if ffprobe:
        stdout, _ = run_process([
            str(ffprobe), "-v", "error", "-select_streams", "v:0",
            "-show_entries", "stream=width,height", "-of", "csv=p=0", str(media),
        ])
        match = re.search(r"(\d+)\s*,\s*(\d+)", stdout)
        if match:
            return int(match.group(1)), int(match.group(2))
    raise EngineError("无法获取视频尺寸，请重新选择视频后再试。")


def pixels(region: dict[str, Any], width: int, height: int) -> tuple[int, int, int, int]:
    x = max(0, min(1, float(region.get("x", 0.05))))
    y = max(0, min(1, float(region.get("y", 0.76))))
    w = max(0.01, min(1 - x, float(region.get("width", 0.9))))
    h = max(0.01, min(1 - y, float(region.get("height", 0.18))))
    left = round(x * width)
    top = round(y * height)
    right = min(width, max(left + 1, round((x + w) * width)))
    bottom = min(height, max(top + 1, round((y + h) * height)))
    return left, top, right - left, bottom - top


def language_code(value: Any, default: str = "auto") -> str:
    text = str(value or "").strip()
    aliases = {
        "自动检测": "auto",
        "中文": "ch",
        "简体中文": "ch",
        "繁体中文": "chinese_cht",
        "英语": "en",
        "英文": "en",
        "日语": "ja",
        "韩语": "ko",
    }
    return aliases.get(text, text.lower() or default)


def ocr_environment(model: Path) -> dict[str, str]:
    environment = os.environ.copy()
    # PaddleX/PaddleOCR versions use one of these cache variables. Setting all
    # of them is harmless and keeps model files inside Video Digest's cache.
    environment["PADDLE_PDX_CACHE_HOME"] = str(model)
    environment["PADDLEOCR_HOME"] = str(model)
    environment["PADDLE_PDX_HOME"] = str(model)
    return environment


def run_ocr(config: dict[str, Any], media: Path, work: Path) -> list[dict[str, Any]]:
    cli = executable("videocr-cli.exe", "videocr_cli.exe", "videocr-cli")
    model = path_value(config.get("modelPaths", {}).get("ocr"), "OCR 模型")
    width, height = dimensions(config, media)
    crop_x, crop_y, crop_width, crop_height = pixels(config.get("region", {}), width, height)
    output = work / "ocr.srt"
    language = language_code(config.get("language"), "en")
    command = [
        str(cli), "--video_path", str(media), "--output", str(output),
        "--ocr_engine", "paddleocr", "--lang", language,
        "--crop_x", str(crop_x), "--crop_y", str(crop_y),
        "--crop_width", str(crop_width), "--crop_height", str(crop_height),
        "--use_gpu", "true" if bool(config.get("useGpu")) else "false",
    ]
    emit_progress(5, 100, "ocr", "正在准备 OCR 引擎…")
    run_process(command, ocr_environment(model))
    if not output.exists():
        raise EngineError("OCR 引擎没有生成字幕文件。")
    emit_progress(95, 100, "ocr", "正在整理 OCR 字幕…")
    return parse_srt(output)


def run_asr(config: dict[str, Any], media: Path, work: Path) -> list[dict[str, Any]]:
    ffmpeg = executable("ffmpeg.exe", "ffmpeg")
    whisper = executable("whisper-cli.exe", "whisper-cli")
    model = model_file(config.get("modelPaths", {}).get("asr"), "ASR 模型", (".bin", ".ggml", ".gguf"))
    wav = work / "audio.wav"
    output_base = work / "asr"
    emit_progress(5, 100, "asr", "正在提取音频…")
    run_process([
        str(ffmpeg), "-hide_banner", "-loglevel", "error", "-y", "-i", str(media),
        "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", str(wav),
    ])
    language = language_code(config.get("language"), "auto")
    emit_progress(35, 100, "asr", "正在运行语音识别…")
    run_process([
        str(whisper), "-m", str(model), "-f", str(wav),
        "--output-json-full", "--output-file", str(output_base),
        "--language", language, "--no-prints",
    ])
    candidates = [output_base.with_suffix(".json"), *work.glob("asr*.json")]
    result_file = next((candidate for candidate in candidates if candidate.exists()), None)
    if result_file is None:
        raise EngineError("ASR 引擎没有生成 JSON 字幕结果。")
    emit_progress(95, 100, "asr", "正在整理 ASR 字幕…")
    return parse_whisper_json(result_file)


def run(config: dict[str, Any]) -> dict[str, Any]:
    global CANCELED
    CANCELED = False
    media = path_value(config.get("filePath"), "媒体文件")
    mode = str(config.get("mode") or "both").lower()
    if mode not in {"ocr", "asr", "both"}:
        raise EngineError(f"不支持的识别模式：{mode}")
    tracks: dict[str, dict[str, Any]] = {}
    with tempfile.TemporaryDirectory(prefix="video-digest-engine-") as temporary:
        work = Path(temporary)
        if mode in {"ocr", "both"}:
            segments = run_ocr(config, media, work)
            tracks["ocr"] = {"kind": "ocr", "language": language_code(config.get("language"), ""), "segments": segments}
        if mode in {"asr", "both"}:
            segments = run_asr(config, media, work)
            tracks["asr"] = {"kind": "asr", "language": language_code(config.get("language"), ""), "segments": segments}
    if not any(track.get("segments") for track in tracks.values()):
        raise EngineError("识别引擎没有返回有效字幕。")
    context = config.get("context") if isinstance(config.get("context"), dict) else {}
    return {
        "sourceId": str(config.get("sourceId") or media.stem),
        "title": str(context.get("title") or media.name),
        "fileName": media.name,
        "mode": mode,
        "region": config.get("region") or {},
        "tracks": tracks,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Video Digest JSONL OCR/ASR adapter")
    parser.add_argument("--config", required=True)
    args = parser.parse_args()
    threading.Thread(target=control_loop, daemon=True, name="engine-control").start()
    try:
        config = json.loads(Path(args.config).read_text(encoding="utf-8"))
        result = run(config)
        emit_progress(100, 100, "complete", "识别完成")
        emit({"type": "result", "result": result})
        return 0
    except EngineError as error:
        return fail(str(error))
    except (OSError, ValueError, json.JSONDecodeError) as error:
        return fail(f"识别适配器失败：{error}")


if __name__ == "__main__":
    raise SystemExit(main())
