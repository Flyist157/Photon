# AGENTS.md

## Cursor Cloud specific instructions

Photon is a single, fully client-side React 19 + TypeScript SPA built with Vite 8. There is **no backend, database, or test suite** — the only long-running service is the Vite dev server.

Standard commands live in `package.json` (`dev`, `build`, `lint`, `preview`) and `README.md`. Reference those rather than duplicating them. The update script already runs `npm install`, so dependencies are in place when a session starts.

- **Run dev server:** `npm run dev` → serves on `http://localhost:5173/`. This is the only service to start.
- **Lint / build:** `npm run lint` (eslint) and `npm run build` (`tsc -b && vite build`) should pass cleanly.
- **No tests exist** (no `test` script, no test files/framework). Do not expect a test runner.

### Non-obvious gotcha: testing the camera flow

The core feature (guided positions → wide-angle HDR capture → enhanced listing photos) depends on `getUserMedia`. This VM has **no real camera**, so by default the app shows the banner "Camera access failed. Allow camera permission and reload Photon." To test the full flow in a browser you must launch Chrome with fake-media flags so a synthetic video stream is provided and permission is auto-granted:

```
--use-fake-device-for-media-stream --use-fake-ui-for-media-stream
```

With those flags, the manual path works end to end: `Start photo session` → for each guided position click `Capture wide-angle HDR` → capture at least the three required positions → `Generate enhanced listing photos` → gallery with HDR-enhanced photo cards that download as JPGs.
