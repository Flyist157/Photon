# Photon

Photon is a mobile-first room scanning app that guides a user through a 360° capture pass, reconstructs a depth-aware color point cloud, and generates three polished real-estate-style photos with one-click download.

## What it does

1. **Guides a 360° rotation**
   - Instructs the user to stand at room center and rotate slowly.
   - Uses motion sensors when available to track rotation progress and auto-capture every 45°.
   - Provides manual capture fallback when motion permissions are unavailable.

2. **Captures high-resolution frames**
   - Requests rear camera with high-res constraints (`ideal: 3840x2160`).
   - Stores JPEG frames at high quality for reconstruction.

3. **Builds a depth-sensitive real-color 3D model**
   - Converts each frame into a sampled point cloud with per-point RGB values.
   - Estimates pseudo-depth from luminance, edge energy, and geometric priors.
   - Aggregates all captured viewpoints into one room-scale model.

4. **Synthesizes three listing angles**
   - Renders the 3D model from left, center, and right camera poses.

5. **Post-produces each image**
   - Applies white balance, exposure/contrast tuning, color enhancement, and sharpening.

6. **Shows a downloadable gallery**
   - Displays all three photos with a simple one-click download button on each.

## Run locally

```bash
npm install
npm run dev
```

Then open the app in a mobile browser (or device emulator) and grant camera/motion permissions.

## Limitations and best-effort notes

- This implementation performs **on-device heuristic depth reconstruction** rather than full SLAM/photogrammetry.
- Depth quality depends heavily on lighting, texture richness, and smooth user rotation.
- Motion sensors vary by browser/device; manual capture mode is provided as fallback.
- The output is designed to be practical and fast in-browser, but not equivalent to lidar-grade scanning.
