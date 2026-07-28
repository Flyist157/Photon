# Photon

Photon is a mobile-first real-estate imaging app that guides a user to the best photo positions in a room, captures wide-angle HDR brackets from each position, and generates polished listing-ready photos with one-click download.

## What it does

1. **Guides optimal photo positions**
   - Starts with a home-screen planner for bedrooms, bathrooms, kitchens, living/great rooms, yards, and exterior angles.
   - Builds an ordered workflow that guides interiors first, then yard and exterior shots.
   - Coaches the user through hero corner, window-balanced, opposite-corner, entry-context, and feature-detail angles.
   - Prioritizes required angles for every selected room/area, with optional supporting shots for stronger listing coverage.
   - Gives live feedback for low light, window glare, composition, and capture readiness.

2. **Accepts real-estate prompting**
   - Lets the user choose room type, listing-photo style, and a freeform editing goal.
   - Carries that prompt into the photo review and enhancement pass.

3. **Captures wide-angle HDR brackets**
   - Requests the rear camera with high-res 16:9 constraints.
   - Enters a fullscreen landscape camera interface with room and angle overlays.
   - Requests the widest exposed rear camera/lens settings and minimum zoom when browser APIs allow it.
   - Supports tap-to-expose/focus directly on the camera feed when the browser exposes point-of-interest camera controls.
   - Captures highlight-safe, neutral, and shadow-lift brackets at each guided position.
   - Uses a browser-compatible synthetic bracket merge when direct phone exposure control is unavailable.

4. **Reviews the photo session**
   - Scores coverage by completed guided positions.
   - Summarizes lighting, dominant palette, and practical retake recommendations.

5. **Generates listing-ready photos**
   - Merges HDR brackets.
   - Recognizes scene cues such as windows, floor plane, architectural lines, lighting range, color cast, shadow risk, and highlight risk.
   - Builds a non-generative edit plan for white balance, exposure, shadows, highlights, vibrance, denoise, clarity, and sharpening.
   - Upscales the corrected output to 2400×1350 JPGs with one-click download.

## Run locally

```bash
npm install
npm run dev
```

Then open the app in a mobile browser on the same network and grant camera permission.

## Limitations and best-effort notes

- Photon now focuses on guided capture and professional photo enhancement rather than 3D reconstruction.
- Browser camera APIs do not reliably expose physical wide-lens selection, orientation lock, fullscreen, or tap-to-expose point controls across phones, so Photon requests those features and falls back gracefully when the browser denies them.
- Output quality depends on phone camera quality, room lighting, lens cleanliness, and steady landscape capture.
- Photon only performs non-generative editing: light, color, white balance, denoise, sharpening, and upscaling. It does not add, remove, replace, or stage room contents.
- The AI backend is currently a deterministic in-browser inference layer, so the app works without external credentials or network calls. It is structured around typed review and edit-plan outputs that can be replaced by a hosted model endpoint.
