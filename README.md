# Photon

Photon is a mobile-first real-estate imaging app that guides a user through a 360° smartphone capture pass, reconstructs a depth-aware color point cloud, maps the room with an AI-style backend pipeline, and generates polished photorealistic listing photos with one-click download.

## What it does

1. **Guides a 360° rotation**
   - Instructs the user to stand at room center and rotate slowly.
   - Uses motion sensors when available to track rotation progress and auto-capture every 45°.
   - Provides manual capture fallback when motion permissions are unavailable.
   - Samples the live camera stream for real-time prompts about glare, low light, coverage, and next-shot direction.

2. **Accepts real-estate prompting**
   - Lets the user choose room type, listing-photo style, and a freeform marketing/editing prompt.
   - Carries that prompt into the mapping and image-editing pass.

3. **Captures high-resolution frames**
   - Requests rear camera with high-res constraints (`ideal: 3840x2160`).
   - Stores JPEG frames at high quality for reconstruction.

4. **Builds a depth-sensitive real-color 3D model**
   - Converts each frame into a sampled point cloud with per-point RGB values.
   - Estimates pseudo-depth from luminance, edge energy, and geometric priors.
   - Aggregates all captured viewpoints into one room-scale model.

5. **Maps the room with a backend-style AI pipeline**
   - Estimates room dimensions, coverage score, lighting conditions, dominant palette, and likely space features.
   - Produces a structured edit plan and marketing prompt from the captured scene and user instructions.

6. **Synthesizes three listing angles**
   - Selects the nearest real camera frame for each angle as the photoreal base image.
   - Layers model-aware color/depth context into hero, natural-light, and architectural-depth listing photos.

7. **Post-produces each image**
   - Applies prompt-aware white balance, exposure/contrast tuning, warmth, color enhancement, and sharpening.

8. **Shows a downloadable gallery**
   - Displays the animated model preview, room map, edit rationale, and all three downloadable photos.

## Run locally

```bash
npm install
npm run dev
```

Then open the app in a mobile browser (or device emulator) and grant camera/motion permissions.

## Limitations and best-effort notes

- This implementation performs **on-device heuristic depth reconstruction** rather than full SLAM/photogrammetry.
- The AI backend is currently a deterministic in-browser inference layer, so the app works without external credentials or network calls. It is structured around typed mapping and edit-plan outputs that can be replaced by a hosted model endpoint.
- Depth quality depends heavily on lighting, texture richness, and smooth user rotation.
- Motion sensors vary by browser/device; manual capture mode is provided as fallback.
- The output is designed to be practical and fast in-browser, but not equivalent to lidar-grade scanning.
