import { clamp, drawToCanvas, loadImage } from './image'
import type {
  AiPhotoSessionResult,
  CaptureGuidance,
  CapturedFrame,
  ImagingRequest,
  PhotoBrief,
  PhotoEditPlan,
  SessionInsight,
  ShotPosition,
  ShotStatus,
} from '../types'

type ImageStats = {
  brightness: number
  contrast: number
  saturation: number
  warmth: number
  edgeDensity: number
  palette: string[]
}

const DEFAULT_REQUEST: ImagingRequest = {
  roomType: 'Interior room',
  listingGoal: 'Create bright, accurate, professional real-estate photos that make the room feel spacious and true to life.',
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
  const paletteBuckets = [
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
      const bucket = paletteBuckets[clamp(Math.floor((luma * paletteBuckets.length)), 0, paletteBuckets.length - 1)]

      brightness += luma
      brightnessSquared += luma * luma
      saturation += max === 0 ? 0 : (max - min) / max
      warmth += (r - b) / 255
      bucket.r += r
      bucket.g += g
      bucket.b += b
      bucket.count += 1
    }
  }

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

  brightness /= pixelCount
  brightnessSquared /= pixelCount

  return {
    brightness,
    contrast: Math.sqrt(Math.max(0, brightnessSquared - brightness * brightness)),
    saturation: saturation / pixelCount,
    warmth: warmth / pixelCount,
    edgeDensity: edgeSamples ? edgeTotal / edgeSamples : 0,
    palette: paletteBuckets
      .filter((bucket) => bucket.count > 0)
      .map((bucket) => rgbToHex(bucket.r / bucket.count, bucket.g / bucket.count, bucket.b / bucket.count)),
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
      palette: [...acc.palette, ...item.palette],
    }),
    {
      brightness: 0,
      contrast: 0,
      saturation: 0,
      warmth: 0,
      edgeDensity: 0,
      palette: [] as string[],
    },
  )

  return {
    brightness: sum.brightness / total,
    contrast: sum.contrast / total,
    saturation: sum.saturation / total,
    warmth: sum.warmth / total,
    edgeDensity: sum.edgeDensity / total,
    palette: Array.from(new Set(sum.palette)).slice(0, 5),
  }
}

export const buildGuidedShotPlan = (request: ImagingRequest): ShotPosition[] => [
  {
    id: 'hero-corner',
    label: 'Hero corner wide',
    targetHeading: 0,
    placement: 'Stand in the cleanest back corner or doorway, phone at chest height, held landscape.',
    composition: `Show the widest view of the ${request.roomType.toLowerCase()} with two walls and as much floor as possible.`,
    coaching: 'Step back until vertical lines feel straight; avoid pointing down at the floor.',
    priority: 'required',
  },
  {
    id: 'window-pull',
    label: 'Window-balanced HDR',
    targetHeading: 45,
    placement: 'Stand diagonally opposite the main window or brightest wall.',
    composition: 'Include the window edge without aiming directly into glare.',
    coaching: 'Tap the phone screen near the window if your browser supports exposure lock, then capture.',
    priority: 'required',
  },
  {
    id: 'opposite-corner',
    label: 'Opposite corner depth',
    targetHeading: 180,
    placement: 'Move to the opposite corner from the hero shot.',
    composition: 'Capture depth back toward the entry path so buyers understand the room shape.',
    coaching: 'Keep the phone level and include a small strip of ceiling for scale.',
    priority: 'required',
  },
  {
    id: 'entry-context',
    label: 'Entry context',
    targetHeading: 250,
    placement: 'Stand just outside or inside the room entrance.',
    composition: 'Frame the room from the way a buyer first walks in.',
    coaching: 'Back up until the doorway or transition is visible but not blocking the main view.',
    priority: 'recommended',
  },
  {
    id: 'feature-detail',
    label: 'Feature detail',
    targetHeading: 315,
    placement: 'Move near the best selling feature: fireplace, cabinetry, window, fixture, or built-in.',
    composition: 'Capture a tasteful supporting angle, not a close-up crop.',
    coaching: 'Keep the feature in the center third and leave enough surrounding room context.',
    priority: 'recommended',
  },
]

export const summarizeShotStatuses = (
  shotPlan: ShotPosition[],
  frames: CapturedFrame[],
): ShotStatus[] =>
  shotPlan.map((shot) => {
    const capturedBrackets = frames.filter((frame) => frame.shotId === shot.id).length
    return {
      ...shot,
      capturedBrackets,
      complete: capturedBrackets >= 3,
    }
  })

const buildEditPlan = (request: ImagingRequest, stats: ImageStats): PhotoEditPlan => {
  const preset = request.stylePreset
  const brightnessLift = stats.brightness < 0.48 ? 0.14 : stats.brightness > 0.7 ? -0.04 : 0.06

  return {
    preset,
    exposure: clamp(1 + brightnessLift, 0.88, 1.18),
    contrast: preset === 'Luxury Editorial' ? 1.16 : 1.09,
    saturation: preset === 'Bright Rental' ? 1.12 : 1.06,
    warmth: preset === 'Luxury Editorial' ? 1.03 : 0.99,
    clarity: preset === 'Luxury Editorial' ? 1.18 : 1.1,
    verticalCorrection: 0.1,
    retouchInstructions: [
      'merge HDR brackets to protect windows and lift interior shadows',
      'correct wide-angle color and keep walls neutral',
      'preserve structural truth; enhance only exposure, color, clarity, and perspective',
      request.listingGoal.trim() || DEFAULT_REQUEST.listingGoal,
    ],
  }
}

const buildRecommendations = (stats: ImageStats, completedShots: number): string[] => {
  const recommendations = [
    `${completedShots} guided HDR positions captured for listing coverage`,
    'deliver landscape 16:9 frames suitable for MLS and rental platforms',
  ]

  if (stats.brightness < 0.4) {
    recommendations.push('turn on lights or open blinds before retaking dim angles')
  } else if (stats.brightness > 0.7) {
    recommendations.push('watch window glare; the HDR merge is protecting highlights')
  } else {
    recommendations.push('lighting is balanced enough for professional color correction')
  }

  if (stats.edgeDensity < 0.04) {
    recommendations.push('add one more angle with visible trim, cabinets, furniture, or window edges for depth')
  }

  return recommendations
}

const buildPhotoBriefs = (shotPlan: ShotPosition[], frames: CapturedFrame[]): PhotoBrief[] =>
  shotPlan
    .filter((shot) => frames.filter((frame) => frame.shotId === shot.id).length >= 3)
    .map((shot) => ({
      shotId: shot.id,
      label: shot.label,
      purpose: shot.composition,
    }))

export const analyzeLiveCameraFrame = (
  video: HTMLVideoElement,
  currentShot: ShotPosition,
  capturedBrackets: number,
): CaptureGuidance | null => {
  if (!video.videoWidth || !video.videoHeight) {
    return null
  }

  const canvas = document.createElement('canvas')
  canvas.width = 128
  canvas.height = 72
  const ctx = canvas.getContext('2d')
  if (!ctx) {
    return null
  }

  ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
  const stats = analyzeCanvas(canvas)
  const brightnessLabel = stats.brightness < 0.38 ? 'dim' : stats.brightness > 0.72 ? 'very bright' : 'balanced'
  const qualityScore = Math.round(
    clamp((1 - Math.abs(stats.brightness - 0.56)) * 54 + stats.contrast * 88 + stats.edgeDensity * 130, 0, 100),
  )

  if (stats.brightness < 0.34) {
    return {
      headline: 'This angle is underexposed',
      detail: 'Turn on lights, open blinds, or face a brighter wall before capturing the HDR burst.',
      tone: 'warning',
      qualityScore,
      brightnessLabel,
      nextShot: currentShot.placement,
    }
  }

  if (stats.brightness > 0.78) {
    return {
      headline: 'Reduce window glare',
      detail: 'Shift a few steps sideways or tilt away from the window. The HDR merge can help, but clipped windows still lose detail.',
      tone: 'action',
      qualityScore,
      brightnessLabel,
      nextShot: currentShot.coaching,
    }
  }

  if (capturedBrackets < 3) {
    return {
      headline: `Ready for ${currentShot.label}`,
      detail: `${currentShot.composition} Capture a steady HDR burst from this position.`,
      tone: 'action',
      qualityScore,
      brightnessLabel,
      nextShot: currentShot.coaching,
    }
  }

  return {
    headline: 'HDR position captured',
    detail: 'This angle has a full bracket set. Move to the next guided position for stronger listing coverage.',
    tone: 'good',
    qualityScore,
    brightnessLabel,
    nextShot: 'Continue to the next recommended position.',
  }
}

export const reviewPhotoSession = async (
  frames: CapturedFrame[],
  shotPlan: ShotPosition[],
  request: ImagingRequest = DEFAULT_REQUEST,
): Promise<AiPhotoSessionResult> => {
  await new Promise((resolve) => window.setTimeout(resolve, 160))

  const neutralFrames = frames.filter((frame) => frame.exposureBias === 0)
  const stats = await Promise.all(
    neutralFrames.map(async (frame) => {
      const image = await loadImage(frame.imageDataUrl)
      const scale = 260 / Math.max(image.width, image.height)
      const canvas = drawToCanvas(
        image,
        Math.max(1, Math.round(image.width * scale)),
        Math.max(1, Math.round(image.height * scale)),
      )
      return analyzeCanvas(canvas)
    }),
  )
  const combinedStats = averageStats(stats)
  const completedShots = summarizeShotStatuses(shotPlan, frames).filter((shot) => shot.complete).length
  const insight: SessionInsight = {
    coverageScore: Math.round(clamp((completedShots / Math.max(1, shotPlan.length)) * 100, 0, 100)),
    lighting: combinedStats.brightness < 0.4 ? 'dim' : combinedStats.brightness > 0.66 ? 'bright' : 'balanced',
    dominantPalette: combinedStats.palette,
    recommendations: buildRecommendations(combinedStats, completedShots),
  }

  return {
    insight,
    editPlan: buildEditPlan(request, combinedStats),
    marketingPrompt: `${request.stylePreset} ${request.roomType} photo set: ${request.listingGoal.trim() || DEFAULT_REQUEST.listingGoal}`,
    photoBriefs: buildPhotoBriefs(shotPlan, frames),
    completedShots,
  }
}
