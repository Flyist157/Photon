import { clamp, loadImage } from './image'
import type {
  AiCorrectionPlan,
  CapturedFrame,
  DetectedPhotoContent,
  PhotoBrief,
  PhotoEditPlan,
  StyledPhoto,
} from '../types'

const OUTPUT_WIDTH = 1600
const OUTPUT_HEIGHT = 900
const UPSCALED_WIDTH = 2400
const UPSCALED_HEIGHT = 1350

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

const lumaFor = (r: number, g: number, b: number): number => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255

const analyzePhotoContent = (imageData: ImageData, width: number, height: number): DetectedPhotoContent => {
  const buffer = imageData.data
  let lumaTotal = 0
  let shadowPixels = 0
  let highlightPixels = 0
  let avgR = 0
  let avgG = 0
  let avgB = 0
  let edgeEnergy = 0
  let edgeSamples = 0
  let topBrightness = 0
  let centerBrightness = 0
  let lowerBrightness = 0
  let topCount = 0
  let centerCount = 0
  let lowerCount = 0

  const sampleLuma = (x: number, y: number): number => {
    const px = clamp(x, 0, width - 1)
    const py = clamp(y, 0, height - 1)
    const idx = (py * width + px) * 4
    return lumaFor(buffer[idx], buffer[idx + 1], buffer[idx + 2])
  }

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const idx = (y * width + x) * 4
      const r = buffer[idx]
      const g = buffer[idx + 1]
      const b = buffer[idx + 2]
      const luma = lumaFor(r, g, b)

      avgR += r
      avgG += g
      avgB += b
      lumaTotal += luma
      if (luma < 0.18) {
        shadowPixels += 1
      }
      if (luma > 0.86) {
        highlightPixels += 1
      }

      if (y < height * 0.33) {
        topBrightness += luma
        topCount += 1
      } else if (y < height * 0.68) {
        centerBrightness += luma
        centerCount += 1
      } else {
        lowerBrightness += luma
        lowerCount += 1
      }
    }
  }

  for (let y = 1; y < height - 1; y += 5) {
    for (let x = 1; x < width - 1; x += 5) {
      edgeEnergy += Math.abs(sampleLuma(x - 1, y) - sampleLuma(x + 1, y))
      edgeEnergy += Math.abs(sampleLuma(x, y - 1) - sampleLuma(x, y + 1))
      edgeSamples += 1
    }
  }

  const pixelCount = width * height
  avgR /= pixelCount
  avgG /= pixelCount
  avgB /= pixelCount
  const avgLuma = lumaTotal / pixelCount
  const shadowRisk = shadowPixels / pixelCount
  const highlightRisk = highlightPixels / pixelCount
  const edgeDensity = edgeSamples ? edgeEnergy / edgeSamples : 0
  const top = topBrightness / Math.max(1, topCount)
  const center = centerBrightness / Math.max(1, centerCount)
  const lower = lowerBrightness / Math.max(1, lowerCount)
  const dynamicRange = highlightRisk + shadowRisk
  const windowConfidence = clamp((top - center) * 1.5 + highlightRisk * 2.4, 0, 1)

  const colorCast =
    avgG > avgR * 1.08 && avgG > avgB * 1.08
      ? 'green'
      : avgR > avgG * 1.06 && avgB > avgG * 1.04
        ? 'magenta'
        : avgB > avgR * 1.1
          ? 'cool'
          : avgR > avgB * 1.12
            ? 'warm'
            : 'neutral'

  const tags = ['interior photo']
  if (windowConfidence > 0.42) {
    tags.push('window or bright opening')
  }
  if (lower < center - 0.06) {
    tags.push('floor plane')
  }
  if (edgeDensity > 0.065) {
    tags.push('architectural lines')
  }
  if (dynamicRange > 0.12) {
    tags.push('high contrast lighting')
  }

  return {
    tags,
    lighting:
      dynamicRange > 0.14
        ? 'high-dynamic-range'
        : avgLuma < 0.38
          ? 'underexposed'
          : avgLuma > 0.72
            ? 'overexposed'
            : 'balanced',
    colorCast,
    detailLevel: edgeDensity < 0.035 ? 'low' : edgeDensity > 0.09 ? 'high' : 'moderate',
    windowConfidence,
    shadowRisk,
    highlightRisk,
  }
}

const buildAiCorrectionPlan = (
  content: DetectedPhotoContent,
  editPlan: PhotoEditPlan,
): AiCorrectionPlan => {
  const whiteBalance = {
    redGain: content.colorCast === 'cool' ? 1.05 : content.colorCast === 'warm' ? 0.97 : content.colorCast === 'green' ? 1.04 : 1,
    greenGain: content.colorCast === 'green' ? 0.94 : content.colorCast === 'magenta' ? 1.04 : 1,
    blueGain: content.colorCast === 'warm' ? 1.05 : content.colorCast === 'cool' ? 0.96 : content.colorCast === 'magenta' ? 0.98 : 1,
  }
  const reasons = [
    `recognized ${content.tags.join(', ')}`,
    `${content.lighting.replace(/-/g, ' ')} lighting profile`,
  ]

  if (content.colorCast !== 'neutral') {
    reasons.push(`corrected ${content.colorCast} color cast`)
  }
  if (content.highlightRisk > 0.04 || content.windowConfidence > 0.42) {
    reasons.push('recovered bright window/highlight detail')
  }
  if (content.shadowRisk > 0.08) {
    reasons.push('lifted dark corners and shadowed floor detail')
  }
  if (content.detailLevel === 'low') {
    reasons.push('added clarity and upscale sharpening for low-detail source')
  }

  return {
    exposureLift:
      content.lighting === 'underexposed' ? 0.1 : content.lighting === 'overexposed' ? -0.06 : editPlan.exposure - 1,
    shadowLift: clamp(content.shadowRisk * 1.45 + (content.windowConfidence > 0.42 ? 0.08 : 0), 0.03, 0.28),
    highlightRecovery: clamp(content.highlightRisk * 1.8 + content.windowConfidence * 0.16, 0.02, 0.32),
    whiteBalance,
    vibrance: editPlan.saturation + (content.detailLevel === 'low' ? 0.03 : 0),
    clarity: editPlan.clarity + (content.detailLevel === 'low' ? 0.08 : 0),
    denoise: content.detailLevel === 'low' || content.shadowRisk > 0.12 ? 0.18 : 0.08,
    sharpen: content.detailLevel === 'high' ? 0.9 : 1.12,
    upscaleMultiplier: UPSCALED_WIDTH / OUTPUT_WIDTH,
    reasons,
  }
}

const softenFineNoise = (imageData: ImageData, width: number, height: number, amount: number): ImageData => {
  const src = imageData.data
  const output = new Uint8ClampedArray(src)
  const blend = clamp(amount, 0, 0.35)

  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const idx = (y * width + x) * 4
      const centerLuma = lumaFor(src[idx], src[idx + 1], src[idx + 2])
      const shadowMask = clamp((0.42 - centerLuma) * 2.4, 0, 1)
      if (shadowMask <= 0) {
        continue
      }

      for (let channel = 0; channel < 3; channel += 1) {
        const average =
          (src[((y - 1) * width + x) * 4 + channel] +
            src[((y + 1) * width + x) * 4 + channel] +
            src[(y * width + x - 1) * 4 + channel] +
            src[(y * width + x + 1) * 4 + channel]) /
          4
        output[idx + channel] = Math.round(src[idx + channel] * (1 - blend * shadowMask) + average * blend * shadowMask)
      }
    }
  }

  return new ImageData(output, width, height)
}

const applyListingLook = (
  imageData: ImageData,
  width: number,
  height: number,
  editPlan: PhotoEditPlan,
  correctionPlan: AiCorrectionPlan,
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
    let r = buffer[i] * gainR * editPlan.exposure * editPlan.warmth * correctionPlan.whiteBalance.redGain
    let g = buffer[i + 1] * gainG * editPlan.exposure * correctionPlan.whiteBalance.greenGain
    let b = (buffer[i + 2] * gainB * editPlan.exposure * correctionPlan.whiteBalance.blueGain) / editPlan.warmth
    const lumaBeforeTone = (r + g + b) / 765
    const shadowMask = clamp((0.48 - lumaBeforeTone) * 2.2, 0, 1)
    const highlightMask = clamp((lumaBeforeTone - 0.62) * 2.4, 0, 1)

    r *= 1 + correctionPlan.exposureLift
    g *= 1 + correctionPlan.exposureLift
    b *= 1 + correctionPlan.exposureLift

    r = r * (1 - highlightMask * correctionPlan.highlightRecovery) + 255 * shadowMask * correctionPlan.shadowLift * 0.24
    g = g * (1 - highlightMask * correctionPlan.highlightRecovery) + 255 * shadowMask * correctionPlan.shadowLift * 0.24
    b = b * (1 - highlightMask * correctionPlan.highlightRecovery) + 255 * shadowMask * correctionPlan.shadowLift * 0.24

    r = ((r - 128) * editPlan.contrast + 128) * 1.03
    g = ((g - 128) * editPlan.contrast + 128) * 1.03
    b = ((b - 128) * editPlan.contrast + 128) * 1.03

    const luma = (r + g + b) / 3
    const vibranceBoost = correctionPlan.vibrance + clamp((128 - Math.abs(luma - 128)) / 128, 0, 1) * 0.03
    r = luma + (r - luma) * vibranceBoost
    g = luma + (g - luma) * vibranceBoost
    b = luma + (b - luma) * vibranceBoost

    buffer[i] = clamp(Math.round(r), 0, 255)
    buffer[i + 1] = clamp(Math.round(g), 0, 255)
    buffer[i + 2] = clamp(Math.round(b), 0, 255)
  }

  const denoised = correctionPlan.denoise > 0.1 ? softenFineNoise(imageData, width, height, correctionPlan.denoise) : imageData
  return sharpen(denoised, width, height, correctionPlan.clarity * correctionPlan.sharpen)
}

const upscaleForExport = (
  imageData: ImageData,
  sourceWidth: number,
  sourceHeight: number,
  targetWidth: number,
  targetHeight: number,
): ImageData => {
  const sourceCanvas = document.createElement('canvas')
  sourceCanvas.width = sourceWidth
  sourceCanvas.height = sourceHeight
  const sourceCtx = sourceCanvas.getContext('2d')
  if (!sourceCtx) {
    throw new Error('Unable to prepare image for upscaling.')
  }
  sourceCtx.putImageData(imageData, 0, 0)

  const targetCanvas = document.createElement('canvas')
  targetCanvas.width = targetWidth
  targetCanvas.height = targetHeight
  const targetCtx = targetCanvas.getContext('2d')
  if (!targetCtx) {
    throw new Error('Unable to initialize upscaling canvas.')
  }

  targetCtx.imageSmoothingEnabled = true
  targetCtx.imageSmoothingQuality = 'high'
  targetCtx.drawImage(sourceCanvas, 0, 0, targetWidth, targetHeight)
  return sharpen(targetCtx.getImageData(0, 0, targetWidth, targetHeight), targetWidth, targetHeight, 0.62)
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
  const detectedContent = analyzePhotoContent(merged, OUTPUT_WIDTH, OUTPUT_HEIGHT)
  const correctionPlan = buildAiCorrectionPlan(detectedContent, editPlan)
  const enhanced = applyListingLook(merged, OUTPUT_WIDTH, OUTPUT_HEIGHT, editPlan, correctionPlan)
  const upscaled = upscaleForExport(enhanced, OUTPUT_WIDTH, OUTPUT_HEIGHT, UPSCALED_WIDTH, UPSCALED_HEIGHT)

  const canvas = document.createElement('canvas')
  canvas.width = UPSCALED_WIDTH
  canvas.height = UPSCALED_HEIGHT
  const ctx = canvas.getContext('2d')
  if (!ctx) {
    throw new Error('Unable to initialize HDR output canvas.')
  }

  ctx.putImageData(upscaled, 0, 0)
  const editSummary = `${brief.purpose} HDR merged and corrected with ${editPlan.preset}.`

  return {
    id: `${brief.shotId}-${Date.now()}`,
    shotId: brief.shotId,
    angleLabel: brief.label,
    dataUrl: canvas.toDataURL('image/jpeg', 0.96),
    width: UPSCALED_WIDTH,
    height: UPSCALED_HEIGHT,
    editSummary,
    qualityScore: Math.round(
      clamp((shotFrames.length / 3) * 58 + (1 - detectedContent.shadowRisk) * 15 + correctionPlan.clarity * 14 + 10, 45, 99),
    ),
    bracketCount: shotFrames.length,
    detectedContent,
    correctionPlan,
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
