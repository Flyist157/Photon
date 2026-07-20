import { clamp, drawToCanvas, loadImage } from './image'
import type {
  AiPipelineResult,
  CaptureGuidance,
  CapturedFrame,
  ImagingRequest,
  PhotoBrief,
  PhotoEditPlan,
  RoomModel,
  SpaceMap,
  SpaceFeature,
} from '../types'

type ImageStats = {
  brightness: number
  contrast: number
  saturation: number
  warmth: number
  edgeDensity: number
  topBrightness: number
  middleBrightness: number
  bottomBrightness: number
  palette: string[]
}

const DEFAULT_REQUEST: ImagingRequest = {
  roomType: 'Interior room',
  listingGoal: 'Create bright, photorealistic real-estate listing images that make the room feel spacious and true to life.',
  stylePreset: 'MLS Clean',
}

const toHex = (value: number): string => clamp(Math.round(value), 0, 255).toString(16).padStart(2, '0')

const rgbToHex = (r: number, g: number, b: number): string => `#${toHex(r)}${toHex(g)}${toHex(b)}`

const getPixel = (data: Uint8ClampedArray, width: number, x: number, y: number): [number, number, number] => {
  const idx = (y * width + x) * 4
  return [data[idx], data[idx + 1], data[idx + 2]]
}

const analyzeImageData = (imageData: ImageData): ImageStats => {
  const { data, width, height } = imageData
  let brightness = 0
  let brightnessSquared = 0
  let saturation = 0
  let warmth = 0
  let topBrightness = 0
  let middleBrightness = 0
  let bottomBrightness = 0
  let topCount = 0
  let middleCount = 0
  let bottomCount = 0
  const bands = [
    { r: 0, g: 0, b: 0, count: 0 },
    { r: 0, g: 0, b: 0, count: 0 },
    { r: 0, g: 0, b: 0, count: 0 },
  ]

  const pixelCount = width * height
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = getPixel(data, width, x, y)
      const luma = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255
      const max = Math.max(r, g, b)
      const min = Math.min(r, g, b)
      const bandIndex = clamp(Math.floor((y / height) * bands.length), 0, bands.length - 1)
      const band = bands[bandIndex]

      brightness += luma
      brightnessSquared += luma * luma
      saturation += max === 0 ? 0 : (max - min) / max
      warmth += (r - b) / 255
      band.r += r
      band.g += g
      band.b += b
      band.count += 1

      if (y < height * 0.34) {
        topBrightness += luma
        topCount += 1
      } else if (y < height * 0.68) {
        middleBrightness += luma
        middleCount += 1
      } else {
        bottomBrightness += luma
        bottomCount += 1
      }
    }
  }

  brightness /= pixelCount
  brightnessSquared /= pixelCount

  let edgeTotal = 0
  let edgeSamples = 0
  for (let y = 1; y < height - 1; y += 4) {
    for (let x = 1; x < width - 1; x += 4) {
      const [leftR, leftG, leftB] = getPixel(data, width, x - 1, y)
      const [rightR, rightG, rightB] = getPixel(data, width, x + 1, y)
      const [topR, topG, topB] = getPixel(data, width, x, y - 1)
      const [bottomR, bottomG, bottomB] = getPixel(data, width, x, y + 1)
      const horizontal = Math.abs(leftR - rightR) + Math.abs(leftG - rightG) + Math.abs(leftB - rightB)
      const vertical = Math.abs(topR - bottomR) + Math.abs(topG - bottomG) + Math.abs(topB - bottomB)
      edgeTotal += clamp((horizontal + vertical) / 765, 0, 1)
      edgeSamples += 1
    }
  }

  return {
    brightness,
    contrast: Math.sqrt(Math.max(0, brightnessSquared - brightness * brightness)),
    saturation: saturation / pixelCount,
    warmth: warmth / pixelCount,
    edgeDensity: edgeSamples ? edgeTotal / edgeSamples : 0,
    topBrightness: topBrightness / Math.max(1, topCount),
    middleBrightness: middleBrightness / Math.max(1, middleCount),
    bottomBrightness: bottomBrightness / Math.max(1, bottomCount),
    palette: bands.map((band) => rgbToHex(band.r / Math.max(1, band.count), band.g / Math.max(1, band.count), band.b / Math.max(1, band.count))),
  }
}

const analyzeCanvas = (canvas: HTMLCanvasElement): ImageStats => {
  const ctx = canvas.getContext('2d')
  if (!ctx) {
    throw new Error('Unable to inspect camera frame.')
  }

  return analyzeImageData(ctx.getImageData(0, 0, canvas.width, canvas.height))
}

const averageStats = (stats: ImageStats[]): ImageStats => {
  const total = Math.max(1, stats.length)
  const sum = stats.reduce(
    (acc, item) => ({
      brightness: acc.brightness + item.brightness,
      contrast: acc.contrast + item.contrast,
      saturation: acc.saturation + item.saturation,
      warmth: acc.warmth + item.warmth,
      edgeDensity: acc.edgeDensity + item.edgeDensity,
      topBrightness: acc.topBrightness + item.topBrightness,
      middleBrightness: acc.middleBrightness + item.middleBrightness,
      bottomBrightness: acc.bottomBrightness + item.bottomBrightness,
      palette: [...acc.palette, ...item.palette],
    }),
    {
      brightness: 0,
      contrast: 0,
      saturation: 0,
      warmth: 0,
      edgeDensity: 0,
      topBrightness: 0,
      middleBrightness: 0,
      bottomBrightness: 0,
      palette: [] as string[],
    },
  )

  return {
    brightness: sum.brightness / total,
    contrast: sum.contrast / total,
    saturation: sum.saturation / total,
    warmth: sum.warmth / total,
    edgeDensity: sum.edgeDensity / total,
    topBrightness: sum.topBrightness / total,
    middleBrightness: sum.middleBrightness / total,
    bottomBrightness: sum.bottomBrightness / total,
    palette: Array.from(new Set(sum.palette)).slice(0, 5),
  }
}

const coverageScore = (frames: CapturedFrame[]): number => {
  if (frames.length < 2) {
    return 0
  }

  const headings = [...frames.map((frame) => frame.heading)].sort((a, b) => a - b)
  const gaps = headings.map((heading, index) => {
    const next = headings[(index + 1) % headings.length]
    return index === headings.length - 1 ? next + 360 - heading : next - heading
  })
  const largestGap = Math.max(...gaps)
  const frameScore = clamp(frames.length / 8, 0, 1)
  const gapScore = clamp(1 - Math.max(0, largestGap - 65) / 180, 0, 1)
  return Math.round((frameScore * 0.55 + gapScore * 0.45) * 100)
}

const estimateDimensions = (model: RoomModel): SpaceMap['estimatedDimensions'] => {
  const bounds = model.points.reduce(
    (acc, point) => ({
      minX: Math.min(acc.minX, point.x),
      maxX: Math.max(acc.maxX, point.x),
      minY: Math.min(acc.minY, point.y),
      maxY: Math.max(acc.maxY, point.y),
      minZ: Math.min(acc.minZ, point.z),
      maxZ: Math.max(acc.maxZ, point.z),
    }),
    {
      minX: Number.POSITIVE_INFINITY,
      maxX: Number.NEGATIVE_INFINITY,
      minY: Number.POSITIVE_INFINITY,
      maxY: Number.NEGATIVE_INFINITY,
      minZ: Number.POSITIVE_INFINITY,
      maxZ: Number.NEGATIVE_INFINITY,
    },
  )

  return {
    widthMeters: Number(clamp(bounds.maxX - bounds.minX, 2.4, 12).toFixed(1)),
    depthMeters: Number(clamp(bounds.maxZ - bounds.minZ, 2.4, 12).toFixed(1)),
    heightMeters: Number(clamp(bounds.maxY - bounds.minY, 2.2, 3.4).toFixed(1)),
    confidence: clamp(model.sourceFrames / 10 + model.points.length / 140000, 0.42, 0.92),
  }
}

const detectFeatures = (stats: ImageStats): SpaceFeature[] => {
  const features: SpaceFeature[] = []
  if (stats.topBrightness - stats.middleBrightness > 0.12 || stats.brightness > 0.62) {
    features.push({
      label: 'natural light source',
      confidence: clamp(0.56 + stats.topBrightness * 0.34, 0, 0.94),
      evidence: 'upper-frame brightness suggests windows or strong daylight',
    })
  }

  if (stats.edgeDensity > 0.08) {
    features.push({
      label: 'architectural detail',
      confidence: clamp(0.52 + stats.edgeDensity * 2.2, 0, 0.93),
      evidence: 'edge density indicates trim, cabinetry, shelving, or furniture lines',
    })
  }

  if (stats.bottomBrightness < stats.middleBrightness - 0.06) {
    features.push({
      label: 'defined flooring plane',
      confidence: clamp(0.58 + (stats.middleBrightness - stats.bottomBrightness), 0, 0.9),
      evidence: 'lower-frame tonal separation creates a clear floor boundary',
    })
  }

  if (stats.warmth > 0.05) {
    features.push({
      label: 'warm interior finishes',
      confidence: clamp(0.55 + stats.warmth * 1.8, 0, 0.9),
      evidence: 'red/yellow channel balance suggests wood, warm paint, or incandescent fixtures',
    })
  }

  return features.length
    ? features
    : [
        {
          label: 'clean room envelope',
          confidence: 0.52,
          evidence: 'balanced color and contrast without a dominant architectural cue',
        },
      ]
}

const buildEditPlan = (request: ImagingRequest, stats: ImageStats): PhotoEditPlan => {
  const preset = request.stylePreset
  const brightnessLift = stats.brightness < 0.48 ? 0.13 : stats.brightness > 0.68 ? -0.04 : 0.05

  return {
    preset,
    exposure: clamp(1 + brightnessLift, 0.88, 1.18),
    contrast: preset === 'Luxury Editorial' ? 1.18 : 1.1,
    saturation: preset === 'Bright Rental' ? 1.13 : 1.08,
    warmth: preset === 'Luxury Editorial' ? 1.04 : 0.99,
    clarity: preset === 'Luxury Editorial' ? 1.2 : 1.12,
    verticalCorrection: 0.08,
    retouchInstructions: [
      'balance mixed lighting while preserving true wall color',
      'lift shadow detail around corners and floor transitions',
      'keep vertical lines upright for listing-platform credibility',
      request.listingGoal.trim() || DEFAULT_REQUEST.listingGoal,
    ],
  }
}

const buildPhotoBriefs = (request: ImagingRequest): PhotoBrief[] => [
  {
    label: 'Hero Wide',
    yawDegrees: 0,
    purpose: `${request.roomType} overview with the widest, cleanest sightline`,
  },
  {
    label: 'Natural Light Angle',
    yawDegrees: -35,
    purpose: 'show window-side brightness and depth cues without overexposure',
  },
  {
    label: 'Architectural Depth',
    yawDegrees: 35,
    purpose: 'emphasize room scale, corners, finish detail, and floor continuity',
  },
]

export const analyzeLiveCameraFrame = (
  video: HTMLVideoElement,
  capturedCount: number,
  rotationDegrees: number,
): CaptureGuidance | null => {
  if (!video.videoWidth || !video.videoHeight) {
    return null
  }

  const canvas = document.createElement('canvas')
  canvas.width = 96
  canvas.height = 128
  const ctx = canvas.getContext('2d')
  if (!ctx) {
    return null
  }

  ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
  const stats = analyzeCanvas(canvas)
  const brightnessLabel = stats.brightness < 0.38 ? 'dim' : stats.brightness > 0.72 ? 'very bright' : 'balanced'
  const coverageNeeded = capturedCount < 6
  const qualityScore = Math.round(
    clamp((1 - Math.abs(stats.brightness - 0.56)) * 58 + stats.contrast * 80 + stats.edgeDensity * 120, 0, 100),
  )

  if (stats.brightness < 0.34) {
    return {
      headline: 'Aim toward a brighter wall',
      detail: 'The backend prompt model sees low light. Turn on room lights or face the window before the next capture.',
      tone: 'warning',
      qualityScore,
      brightnessLabel,
      nextShot: 'Capture after exposure settles.',
    }
  }

  if (stats.brightness > 0.78) {
    return {
      headline: 'Avoid direct glare',
      detail: 'The live frame is close to clipping. Angle slightly away from the window to preserve exterior and wall detail.',
      tone: 'action',
      qualityScore,
      brightnessLabel,
      nextShot: 'Shift 10-15 degrees, then capture.',
    }
  }

  if (coverageNeeded) {
    return {
      headline: 'Keep rotating for full room coverage',
      detail: `Captured ${capturedCount} viewpoints. The mapping backend needs at least 6, with even spacing around the room.`,
      tone: 'action',
      qualityScore,
      brightnessLabel,
      nextShot: `Next target around ${Math.min(360, Math.round(rotationDegrees + 45))} degrees.`,
    }
  }

  return {
    headline: 'Good frame for photoreal output',
    detail: 'Lighting and texture are strong enough for depth cues, color matching, and listing-photo enhancement.',
    tone: 'good',
    qualityScore,
    brightnessLabel,
    nextShot: capturedCount >= 8 ? 'Finish rotation when you return to the start point.' : 'Capture another evenly spaced angle.',
  }
}

export const mapSpaceWithAiBackend = async (
  frames: CapturedFrame[],
  model: RoomModel,
  request: ImagingRequest = DEFAULT_REQUEST,
): Promise<AiPipelineResult> => {
  await new Promise((resolve) => window.setTimeout(resolve, 180))

  const stats = await Promise.all(
    frames.map(async (frame) => {
      const image = await loadImage(frame.imageDataUrl)
      const scale = 240 / Math.max(image.width, image.height)
      const canvas = drawToCanvas(
        image,
        Math.max(1, Math.round(image.width * scale)),
        Math.max(1, Math.round(image.height * scale)),
      )
      return analyzeCanvas(canvas)
    }),
  )
  const combinedStats = averageStats(stats)
  const lighting = combinedStats.brightness < 0.4 ? 'dim' : combinedStats.brightness > 0.66 ? 'bright' : 'balanced'
  const score = coverageScore(frames)
  const captureNotes = [
    `${frames.length} smartphone frames registered around the room`,
    `${score}% angular coverage for model synthesis`,
    `${lighting} ambient lighting with ${combinedStats.edgeDensity > 0.08 ? 'strong' : 'moderate'} texture cues`,
  ]

  return {
    spaceMap: {
      estimatedDimensions: estimateDimensions(model),
      coverageScore: score,
      lighting,
      dominantPalette: combinedStats.palette,
      features: detectFeatures(combinedStats),
      captureNotes,
    },
    editPlan: buildEditPlan(request, combinedStats),
    marketingPrompt: `${request.stylePreset} ${request.roomType} listing: ${request.listingGoal.trim() || DEFAULT_REQUEST.listingGoal}`,
    photoBriefs: buildPhotoBriefs(request),
  }
}
