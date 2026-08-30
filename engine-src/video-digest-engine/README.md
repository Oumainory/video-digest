# Video Digest Engine Adapter

This directory contains the source for the small process that translates the
Video Digest `jsonl-v1` contract to the selected local OCR and ASR backends.

The adapter is not the ML model itself. A Windows release supplies these
separate artifacts next to the compiled adapter:

- `videocr-cli.exe` (local VideOCR/PaddleOCR path);
- `whisper-cli.exe` (whisper.cpp);
- `ffmpeg.exe` and, when needed, `ffprobe.exe`;
- model files or model directories;
- the corresponding license and notice files.

The `--config` file is supplied by `companion/engine.cjs`. Video regions are
normalized to `0..1` in the config and converted to pixels before the OCR CLI
is called. OCR produces SRT, while ASR produces whisper.cpp JSON; both are
normalized into the companion transcript structure.

## Build on Windows

Install Python only on the build machine, not on end-user computers:

```powershell
python -m pip install -r requirements.txt
python -m pip install nuitka
.\build-windows.ps1
```

The build script expects the backend binaries in the paths supplied by:

```text
VIDEO_DIGEST_VIDEOCR_CLI
VIDEO_DIGEST_WHISPER_CLI
VIDEO_DIGEST_FFMPEG
VIDEO_DIGEST_FFPROBE (optional when video dimensions are sent by the UI)
```

The generated directory contains `video-digest-engine.exe` and a
`manifest.json` suitable for `VIDEO_DIGEST_ENGINE_DIR`.

## License

The adapter source is part of Video Digest and follows the repository license.
The backend binaries, libraries, models, and their licenses are separate and
must be recorded in `THIRD-PARTY-NOTICES` before distribution.
