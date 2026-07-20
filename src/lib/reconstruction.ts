import { clamp, drawToCanvas, loadImage } from './image'
import type { CapturedFrame, Point3D, RoomModel } from '../types'

const FOV_RADIANS = (58 * Math.PI) / 180
const ROOM_RADIUS_METERS = 3.2
const DEPTH_SCALE_METERS = 2
const ROOM_HEIGHT_METERS = 2.7
const TARGET_LONG_EDGE = 980
const SAMPLE_STEP_PX = 8

const luminance = (r: number, g: number, b: number): number =>
  (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255

const estimateDepth = (
  r: number,
  g: number,
  b: number,
  yRatio: number,
  edgeEnergy: number,
): number => {
  const lum = luminance(r, g, b)
  const ceilingBias = clamp(1 - yRatio * 1.7, 0, 1)
  const floorBias = clamp((yRatio - 0.6) * 1.8, 0, 1)
  const structureBias = clamp(edgeEnergy * 1.3, 0, 1)
  const tonalBias = clamp(1 - lum, 0, 1)
  return clamp(0.25 + tonalBias * 0.45 + structureBias * 0.35 + ceilingBias * 0.1 - floorBias * 0.05, 0, 1)
}

const edgeMagnitude = (
  data: Uint8ClampedArray,
  x: number,
  y: number,
  width: number,
  height: number,
): number => {
  const sample = (sx: number, sy: number): number => {
    const clampedX = clamp(sx, 0, width - 1)
    const clampedY = clamp(sy, 0, height - 1)
    const idx = (clampedY * width + clampedX) * 4
    return luminance(data[idx], data[idx + 1], data[idx + 2])
  }

  const gx =
    -sample(x - 1, y - 1) +
    sample(x + 1, y - 1) -
    2 * sample(x - 1, y) +
    2 * sample(x + 1, y) -
    sample(x - 1, y + 1) +
    sample(x + 1, y + 1)
  const gy =
    sample(x - 1, y - 1) +
    2 * sample(x, y - 1) +
    sample(x + 1, y - 1) -
    sample(x - 1, y + 1) -
    2 * sample(x, y + 1) -
    sample(x + 1, y + 1)
  return clamp(Math.sqrt(gx * gx + gy * gy), 0, 1)
}

export const buildRoomModel = async (frames: CapturedFrame[]): Promise<RoomModel> => {
  if (frames.length < 6) {
    throw new Error('Capture at least 6 images to reconstruct a reliable room model.')
  }

  const points: Point3D[] = []
  for (const frame of frames) {
    const image = await loadImage(frame.imageDataUrl)
    const scale = TARGET_LONG_EDGE / Math.max(image.width, image.height)
    const width = Math.max(1, Math.round(image.width * Math.min(1, scale)))
    const height = Math.max(1, Math.round(image.height * Math.min(1, scale)))
    const canvas = drawToCanvas(image, width, height)
    const ctx = canvas.getContext('2d')
    if (!ctx) {
      continue
    }

    const { data } = ctx.getImageData(0, 0, width, height)
    const headingRadians = (frame.heading * Math.PI) / 180
    for (let y = 0; y < height; y += SAMPLE_STEP_PX) {
      for (let x = 0; x < width; x += SAMPLE_STEP_PX) {
        const idx = (y * width + x) * 4
        const r = data[idx]
        const g = data[idx + 1]
        const b = data[idx + 2]
        const yRatio = y / Math.max(1, height - 1)
        const edgeEnergy = edgeMagnitude(data, x, y, width, height)
        const depthFactor = estimateDepth(r, g, b, yRatio, edgeEnergy)
        const rayOffset = ((x / Math.max(1, width - 1)) - 0.5) * FOV_RADIANS
        const worldAngle = headingRadians + rayOffset
        const radius = ROOM_RADIUS_METERS + depthFactor * DEPTH_SCALE_METERS

        points.push({
          x: Math.cos(worldAngle) * radius,
          y: (0.5 - yRatio) * ROOM_HEIGHT_METERS,
          z: Math.sin(worldAngle) * radius,
          r,
          g,
          b,
        })
      }
    }
  }

  return {
    points,
    sourceFrames: frames.length,
    generatedAt: Date.now(),
  }
}
