import { clamp, loadImage } from './image'
import type { CapturedFrame, PhotoBrief, PhotoEditPlan, StyledPhoto } from '../types'

const OUTPUT_WIDTH = 1600
const OUTPUT_HEIGHT = 900

const DEFAULT_EDIT_PLAN: PhotoEditPlan = {
  preset: 'MLS Clean',
  exposure: 1.06,
  contrast: 1.09,
  saturation: 1.06,
  warmth: 0.99,
  clarity: 1.1,
  verticalCorrection: 0.1,
  retouchInstructions: ['merge HDR brackets', 'correct color', 'keep listing photos accurate'],
}

const drawCoverImage = (
  ctx: CanvasRenderingContext2D,
  image: HTMLImageElement,
  width: number,
  height: number,
): void => {
  const scale = Math.max(width / image.width, height / image.height)
  const drawWidth = image.width * scale
  const drawHeight = image.height * scale
  const offsetX = (width - drawWidth) / 2
  const offsetY = (height - drawHeight) / 2
  ctx.drawImage(image, offsetX, offsetY, drawWidth, drawHeight)
}

const imageDataFromFrame = async (frame: CapturedFrame, width: number, height: number): Promise<ImageData> => {
  const image = await loadImage(frame.imageDataUrl)
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) {
    throw new Error('Unable to create HDR merge surface.')
  }

  drawCoverImage(ctx, image, width, height)
  return ctx.getImageData(0, 0, width, height)
}

const sharpen = (imageData: ImageData, width: number, height: number, clarity: number): ImageData => {
  const src = imageData.data
  const output = new Uint8ClampedArray(src.length)
  const centerWeight = 4 + clarity
  const kernel = [
    [0, -1, 0],
    [-1, centerWeight, -1],
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

const mergeHdrBrackets = (brackets: ImageData[], width: number, height: number): ImageData => {
  const output = new Uint8ClampedArray(width * height * 4)
  const dark = brackets[0]?.data
  const neutral = brackets[1]?.data ?? brackets[0]?.data
  const bright = brackets[2]?.data ?? neutral

  if (!dark || !neutral || !bright) {
    throw new Error('Capture at least one bracket before rendering HDR output.')
  }

  for (let i = 0; i < output.length; i += 4) {
    const neutralLuma = (neutral[i] + neutral[i + 1] + neutral[i + 2]) / 765
    const highlightWeight = clamp((neutralLuma - 0.58) * 1.9, 0, 1)
    const shadowWeight = clamp((0.42 - neutralLuma) * 1.9, 0, 1)
    const neutralWeight = clamp(1 - highlightWeight - shadowWeight, 0.18, 1)
    const totalWeight = highlightWeight + shadowWeight + neutralWeight

    for (let channel = 0; channel < 3; channel += 1) {
      output[i + channel] = clamp(
        Math.round(
          (dark[i + channel] * highlightWeight +
            neutral[i + channel] * neutralWeight +
            bright[i + channel] * shadowWeight) /
            totalWeight,
        ),
        0,
        255,
      )
    }
    output[i + 3] = 255
  }

  return new ImageData(output, width, height)
}

const applyListingLook = (
  imageData: ImageData,
  width: number,
  height: number,
  editPlan: PhotoEditPlan,
): ImageData => {
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
    let r = buffer[i] * gainR * editPlan.exposure * editPlan.warmth
    let g = buffer[i + 1] * gainG * editPlan.exposure
    let b = (buffer[i + 2] * gainB * editPlan.exposure) / editPlan.warmth

    r = ((r - 128) * editPlan.contrast + 128) * 1.03
    g = ((g - 128) * editPlan.contrast + 128) * 1.03
    b = ((b - 128) * editPlan.contrast + 128) * 1.03

    const luma = (r + g + b) / 3
    r = luma + (r - luma) * editPlan.saturation
    g = luma + (g - luma) * editPlan.saturation
    b = luma + (b - luma) * editPlan.saturation

    buffer[i] = clamp(Math.round(r), 0, 255)
    buffer[i + 1] = clamp(Math.round(g), 0, 255)
    buffer[i + 2] = clamp(Math.round(b), 0, 255)
  }

  return sharpen(imageData, width, height, editPlan.clarity)
}

const renderPhoto = async (
  shotFrames: CapturedFrame[],
  brief: PhotoBrief,
  editPlan: PhotoEditPlan,
): Promise<StyledPhoto> => {
  const sortedFrames = [...shotFrames].sort((a, b) => a.exposureBias - b.exposureBias)
  const bracketData = await Promise.all(
    sortedFrames.slice(0, 3).map((frame) => imageDataFromFrame(frame, OUTPUT_WIDTH, OUTPUT_HEIGHT)),
  )
  const merged = mergeHdrBrackets(bracketData, OUTPUT_WIDTH, OUTPUT_HEIGHT)
  const enhanced = applyListingLook(merged, OUTPUT_WIDTH, OUTPUT_HEIGHT, editPlan)

  const canvas = document.createElement('canvas')
  canvas.width = OUTPUT_WIDTH
  canvas.height = OUTPUT_HEIGHT
  const ctx = canvas.getContext('2d')
  if (!ctx) {
    throw new Error('Unable to initialize HDR output canvas.')
  }

  ctx.putImageData(enhanced, 0, 0)

  return {
    id: `${brief.shotId}-${Date.now()}`,
    shotId: brief.shotId,
    angleLabel: brief.label,
    dataUrl: canvas.toDataURL('image/jpeg', 0.96),
    width: OUTPUT_WIDTH,
    height: OUTPUT_HEIGHT,
    editSummary: `${brief.purpose} HDR merged and corrected with ${editPlan.preset}.`,
    qualityScore: Math.round(clamp((shotFrames.length / 3) * 72 + editPlan.clarity * 16 + editPlan.contrast * 10, 45, 99)),
    bracketCount: shotFrames.length,
  }
}

export const generateHdrListingPhotos = async (
  frames: CapturedFrame[],
  editPlan: PhotoEditPlan = DEFAULT_EDIT_PLAN,
  photoBriefs: PhotoBrief[],
): Promise<StyledPhoto[]> =>
  Promise.all(
    photoBriefs.map((brief) => {
      const shotFrames = frames.filter((frame) => frame.shotId === brief.shotId)
      return renderPhoto(shotFrames, brief, editPlan)
    }),
  )
