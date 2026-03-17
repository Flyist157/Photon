import { clamp } from './image'
import type { RoomModel, StyledPhoto } from '../types'

type CameraPose = {
  yaw: number
  pitch: number
  distance: number
  fovDegrees: number
}

type RenderOptions = {
  width: number
  height: number
  background: string
  pointSize: number
}

const toRadians = (degrees: number): number => (degrees * Math.PI) / 180

const createPerspective = (fovDegrees: number, viewportHeight: number): number =>
  viewportHeight / Math.tan(toRadians(fovDegrees) / 2)

const rotateY = (x: number, z: number, yaw: number): [number, number] => {
  const cosY = Math.cos(yaw)
  const sinY = Math.sin(yaw)
  return [x * cosY - z * sinY, x * sinY + z * cosY]
}

const rotateX = (y: number, z: number, pitch: number): [number, number] => {
  const cosP = Math.cos(pitch)
  const sinP = Math.sin(pitch)
  return [y * cosP - z * sinP, y * sinP + z * cosP]
}

const clearBackground = (ctx: CanvasRenderingContext2D, width: number, height: number, color: string): void => {
  ctx.fillStyle = color
  ctx.fillRect(0, 0, width, height)
}

const renderModel = (
  ctx: CanvasRenderingContext2D,
  model: RoomModel,
  camera: CameraPose,
  options: RenderOptions,
): void => {
  const { width, height, pointSize } = options
  clearBackground(ctx, width, height, options.background)
  const focalLength = createPerspective(camera.fovDegrees, height)

  const projected = model.points
    .map((point) => {
      let x = point.x
      let y = point.y
      let z = point.z

      ;[x, z] = rotateY(x, z, -camera.yaw)
      z += camera.distance
      ;[y, z] = rotateX(y, z, -camera.pitch)

      if (z <= 0.2) {
        return null
      }

      const px = (x * focalLength) / z + width / 2
      const py = (y * focalLength) / z + height / 2
      if (px < -2 || py < -2 || px > width + 2 || py > height + 2) {
        return null
      }

      return {
        x: px,
        y: py,
        z,
        color: `rgb(${point.r}, ${point.g}, ${point.b})`,
      }
    })
    .filter((value): value is { x: number; y: number; z: number; color: string } => value !== null)
    .sort((a, b) => b.z - a.z)

  for (const sample of projected) {
    const fog = clamp(1 - sample.z / 11, 0.35, 1)
    ctx.globalAlpha = fog
    ctx.fillStyle = sample.color
    ctx.fillRect(sample.x, sample.y, pointSize, pointSize)
  }
  ctx.globalAlpha = 1
}

const sharpen = (imageData: ImageData, width: number, height: number): ImageData => {
  const src = imageData.data
  const output = new Uint8ClampedArray(src.length)

  const kernel = [
    [0, -1, 0],
    [-1, 5, -1],
    [0, -1, 0],
  ]

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let r = 0
      let g = 0
      let b = 0

      for (let ky = -1; ky <= 1; ky += 1) {
        for (let kx = -1; kx <= 1; kx += 1) {
          const px = clamp(x + kx, 0, width - 1)
          const py = clamp(y + ky, 0, height - 1)
          const idx = (py * width + px) * 4
          const weight = kernel[ky + 1][kx + 1]
          r += src[idx] * weight
          g += src[idx + 1] * weight
          b += src[idx + 2] * weight
        }
      }

      const outIdx = (y * width + x) * 4
      output[outIdx] = clamp(Math.round(r), 0, 255)
      output[outIdx + 1] = clamp(Math.round(g), 0, 255)
      output[outIdx + 2] = clamp(Math.round(b), 0, 255)
      output[outIdx + 3] = src[outIdx + 3]
    }
  }

  return new ImageData(output, width, height)
}

const applyRealEstateLook = (ctx: CanvasRenderingContext2D, width: number, height: number): void => {
  const imageData = ctx.getImageData(0, 0, width, height)
  const buffer = imageData.data
  let avgR = 0
  let avgG = 0
  let avgB = 0
  const pixelCount = width * height

  for (let i = 0; i < buffer.length; i += 4) {
    avgR += buffer[i]
    avgG += buffer[i + 1]
    avgB += buffer[i + 2]
  }

  avgR /= pixelCount
  avgG /= pixelCount
  avgB /= pixelCount
  const avg = (avgR + avgG + avgB) / 3
  const gainR = avg / Math.max(1, avgR)
  const gainG = avg / Math.max(1, avgG)
  const gainB = avg / Math.max(1, avgB)

  for (let i = 0; i < buffer.length; i += 4) {
    let r = buffer[i] * gainR
    let g = buffer[i + 1] * gainG
    let b = buffer[i + 2] * gainB

    r = ((r - 128) * 1.18 + 128) * 1.06
    g = ((g - 128) * 1.18 + 128) * 1.06
    b = ((b - 128) * 1.18 + 128) * 1.06

    const luma = (r + g + b) / 3
    r = luma + (r - luma) * 1.09
    g = luma + (g - luma) * 1.09
    b = luma + (b - luma) * 1.09

    buffer[i] = clamp(Math.round(r), 0, 255)
    buffer[i + 1] = clamp(Math.round(g), 0, 255)
    buffer[i + 2] = clamp(Math.round(b), 0, 255)
  }

  const sharpened = sharpen(imageData, width, height)
  ctx.putImageData(sharpened, 0, 0)
}

export const renderInteractivePreview = (
  canvas: HTMLCanvasElement,
  model: RoomModel,
  yawDegrees: number,
): void => {
  const ctx = canvas.getContext('2d')
  if (!ctx) {
    return
  }

  renderModel(
    ctx,
    model,
    {
      yaw: toRadians(yawDegrees),
      pitch: toRadians(-6),
      distance: 8.2,
      fovDegrees: 52,
    },
    {
      width: canvas.width,
      height: canvas.height,
      background: '#0f172a',
      pointSize: 2,
    },
  )
}

const synthesizePhoto = (
  model: RoomModel,
  yawDegrees: number,
  width: number,
  height: number,
  label: string,
): StyledPhoto => {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) {
    throw new Error('Unable to initialize rendering surface for synthesized photo.')
  }

  renderModel(
    ctx,
    model,
    {
      yaw: toRadians(yawDegrees),
      pitch: toRadians(-4),
      distance: 8,
      fovDegrees: 48,
    },
    {
      width,
      height,
      background: '#fafafa',
      pointSize: 2,
    },
  )

  applyRealEstateLook(ctx, width, height)

  return {
    id: `${label.toLowerCase().replace(/\s+/g, '-')}-${Date.now()}`,
    angleLabel: label,
    dataUrl: canvas.toDataURL('image/jpeg', 0.96),
    width,
    height,
  }
}

export const generateListingPhotos = (model: RoomModel): StyledPhoto[] => [
  synthesizePhoto(model, -35, 1600, 900, 'Left Angle'),
  synthesizePhoto(model, 0, 1600, 900, 'Center Angle'),
  synthesizePhoto(model, 35, 1600, 900, 'Right Angle'),
]
