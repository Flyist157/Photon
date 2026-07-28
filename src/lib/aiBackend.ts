import { clamp, drawToCanvas, loadImage } from './image'
import type {
  AiPhotoSessionResult,
  CaptureGuidance,
  CapturedFrame,
  ImagingRequest,
  PhotoBrief,
  PhotoEditPlan,
  PropertyCapturePlan,
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

const countRange = (count: number): number[] => Array.from({ length: Math.max(0, count) }, (_, index) => index + 1)

const makeInteriorShots = (
  roomLabel: string,
  roomSlug: string,
  baseHeading: number,
): ShotPosition[] => [
  {
    id: `${roomSlug}-hero`,
    label: `${roomLabel} hero wide`,
    roomLabel,
    zone: 'interior',
    targetHeading: baseHeading,
    placement: `Stand in the cleanest back corner or doorway of ${roomLabel.toLowerCase()}, phone at chest height, held landscape.`,
    composition: `Show the widest view of ${roomLabel.toLowerCase()} with two walls and as much floor as possible.`,
    coaching: 'Step back until vertical lines feel straight; avoid pointing down at the floor.',
    priority: 'required',
  },
  {
    id: `${roomSlug}-window-or-feature`,
    label: `${roomLabel} light/detail`,
    roomLabel,
    zone: 'interior',
    targetHeading: baseHeading + 45,
    placement: `Move diagonally opposite the main window, fixture, vanity, cabinetry, or strongest feature in ${roomLabel.toLowerCase()}.`,
    composition: 'Include the bright opening or selling feature without aiming directly into glare.',
    coaching: 'Lock exposure if possible, then keep the phone level and steady.',
    priority: 'recommended',
  },
  {
    id: `${roomSlug}-opposite`,
    label: `${roomLabel} opposite depth`,
    roomLabel,
    zone: 'interior',
    targetHeading: baseHeading + 180,
    placement: `Move to the opposite side of ${roomLabel.toLowerCase()} from the hero angle.`,
    composition: 'Capture depth back toward the entry path so viewers understand the room shape.',
    coaching: 'Include a little ceiling and floor for scale; keep verticals upright.',
    priority: 'required',
  },
]

const makeYardShots = (index: number): ShotPosition[] => {
  const roomLabel = index === 1 ? 'Yard' : `Yard ${index}`
  const roomSlug = `yard-${index}`
  return [
    {
      id: `${roomSlug}-overview`,
      label: `${roomLabel} overview`,
      roomLabel,
      zone: 'exterior',
      targetHeading: 20 + index * 40,
      placement: `Stand at the widest usable corner of ${roomLabel.toLowerCase()}.`,
      composition: 'Show usable outdoor space, boundaries, landscaping, and patio/deck context.',
      coaching: 'Avoid shooting straight into the sun; keep the horizon level.',
      priority: 'required',
    },
    {
      id: `${roomSlug}-feature`,
      label: `${roomLabel} feature angle`,
      roomLabel,
      zone: 'exterior',
      targetHeading: 80 + index * 40,
      placement: 'Move closer to the best exterior feature: patio, view, lawn, garden, pool, or outdoor seating.',
      composition: 'Show the feature with enough surrounding context to feel spacious.',
      coaching: 'Use HDR if sky is bright and foreground is shaded.',
      priority: 'recommended',
    },
  ]
}

const exteriorAngleLabel = (index: number): string =>
  ['Front exterior', 'Left exterior', 'Rear exterior', 'Right exterior'][index - 1] ?? `Exterior angle ${index}`

export const buildGuidedShotPlan = (
  _request: ImagingRequest,
  capturePlan: PropertyCapturePlan,
): ShotPosition[] => [
  ...countRange(capturePlan.livingRooms).flatMap((index) =>
    makeInteriorShots(index === 1 ? 'Living / great room' : `Living / great room ${index}`, `living-${index}`, index * 25),
  ),
  ...countRange(capturePlan.kitchens).flatMap((index) =>
    makeInteriorShots(index === 1 ? 'Kitchen' : `Kitchen ${index}`, `kitchen-${index}`, 90 + index * 25),
  ),
  ...countRange(capturePlan.bedrooms).flatMap((index) =>
    makeInteriorShots(index === 1 ? 'Primary bedroom' : `Bedroom ${index}`, `bedroom-${index}`, 150 + index * 25),
  ),
  ...countRange(capturePlan.bathrooms).flatMap((index) =>
    makeInteriorShots(index === 1 ? 'Primary bathroom' : `Bathroom ${index}`, `bathroom-${index}`, 210 + index * 25),
  ),
  ...countRange(capturePlan.yards).flatMap(makeYardShots),
  ...countRange(capturePlan.exteriorAngles).map((index) => ({
    id: `exterior-${index}`,
    label: exteriorAngleLabel(index),
    roomLabel: 'Exterior',
    zone: 'exterior' as const,
    targetHeading: index * (360 / Math.max(1, capturePlan.exteriorAngles)),
    placement: `Stand far enough back to capture the ${exteriorAngleLabel(index).toLowerCase()} cleanly.`,
    composition: 'Show roofline, entry/yard context, and curb appeal without cutting off corners.',
    coaching: 'Keep the phone level, avoid parked cars when possible, and use HDR for bright sky.',
    priority: 'required' as const,
  })),
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
