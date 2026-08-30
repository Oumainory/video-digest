# Contributing to Video Digest

## Before opening a change

Run:

```powershell
npm test
npm run check
```

Do not commit local videos, audio, model weights, engine binaries, API keys,
or generated `dist/` output. Release binaries and model archives belong in
GitHub Releases, not in the source tree.

## Third-party code

If a change copies, adapts, links to, or bundles an external project:

1. Pin the upstream repository and a version or commit.
2. Read the upstream `LICENSE` and every relevant `NOTICE` file.
3. Record the component in `THIRD-PARTY-NOTICES`.
4. Keep the original copyright and license notice with adapted source where
   practical.
5. Record model and runtime licenses separately from code licenses.

The root `LICENSE` only covers original Video Digest work and does not remove
obligations from third-party licenses.
