# AGENTS.md

## Cursor Cloud specific instructions

Photon is a single, fully client-side React 19 + TypeScript SPA built with Vite 8. There is **no backend, database, or test suite** — the only long-running service is the Vite dev server.

Standard commands live in `package.json` (`dev`, `build`, `lint`, `preview`) and `README.md`. Reference those rather than duplicating them. The update script already runs `npm install`, so dependencies are in place when a session starts.

- **Run dev server:** `npm run dev` → serves on `http://localhost:5173/`. This is the only service to start.
- **Lint / build:** `npm run lint` (eslint) and `npm run build` (`tsc -b && vite build`) both pass cleanly on a fresh install.
- **No tests exist** (no `test` script, no test files/framework). Do not expect a test runner.

### Non-obvious gotcha: testing the camera flow

The core feature (guided scan → 3D reconstruction → 3 listing photos) depends on `getUserMedia`. This VM has **no real camera**, so by default the app shows the banner "Camera access failed. Allow camera permission and reload Photon." To test the full flow in a browser you must launch Chrome with fake-media flags so a synthetic video stream is provided and permission is auto-granted:

```
--use-fake-device-for-media-stream --use-fake-ui-for-media-stream
```

With those flags, the manual-capture path works end to end: `Start scan` → click `Capture now` ~8 times (each advances rotation by 45°) → `Finish rotation` (needs ≥6 captures) → `Build 3D model and generate photos` → gallery with Left/Center/Right angle photos that download as JPGs. Device-motion auto-capture cannot be exercised headlessly, so use the manual `Capture now` button.
