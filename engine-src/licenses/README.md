# Engine license bundle

The release builder copies the exact license and notice files supplied with
the pinned OCR/ASR/FFmpeg artifacts into the final engine directory.

Do not put downloaded model weights or opaque binaries in this directory.
Instead, record their source, version, checksum, copyright holder, and
license in the release inputs and `THIRD-PARTY-NOTICES`.
