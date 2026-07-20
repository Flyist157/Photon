# Photon

Photon is a mobile-first real-estate imaging app that guides a user to the best photo positions in a room, captures wide-angle HDR brackets from each position, and generates polished listing-ready photos with one-click download.

## What it does

1. **Guides optimal photo positions**
   - Coaches the user through hero corner, window-balanced, opposite-corner, entry-context, and feature-detail angles.
   - Prioritizes the three required angles first, with optional supporting shots for stronger listing coverage.
   - Gives live feedback for low light, window glare, composition, and capture readiness.

2. **Accepts real-estate prompting**
   - Lets the user choose room type, listing-photo style, and a freeform editing goal.
   - Carries that prompt into the photo review and enhancement pass.

3. **Captures wide-angle HDR brackets**
   - Requests the rear camera with high-res 16:9 constraints.
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
- Browser camera APIs do not reliably expose physical wide-lens selection or manual exposure control across phones, so HDR brackets are simulated from captured frames when needed.
- Output quality depends on phone camera quality, room lighting, lens cleanliness, and steady landscape capture.
- Photon only performs non-generative editing: light, color, white balance, denoise, sharpening, and upscaling. It does not add, remove, replace, or stage room contents.
- The AI backend is currently a deterministic in-browser inference layer, so the app works without external credentials or network calls. It is structured around typed review and edit-plan outputs that can be replaced by a hosted model endpoint.
