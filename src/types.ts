export type CapturedFrame = {
  id: string
  shotId: string
  shotLabel: string
  exposureBias: -1 | 0 | 1
  heading: number
  imageDataUrl: string
  width: number
  height: number
  capturedAt: number
}

export type ShotPosition = {
  id: string
  label: string
  roomLabel: string
  zone: 'interior' | 'exterior'
  targetHeading: number
  placement: string
  composition: string
  coaching: string
  priority: 'required' | 'recommended'
}

export type PropertyCapturePlan = {
  bedrooms: number
  bathrooms: number
  kitchens: number
  livingRooms: number
  yards: number
  exteriorAngles: number
}

export type ShotStatus = ShotPosition & {
  capturedBrackets: number
  complete: boolean
}

export type CaptureGuidance = {
  headline: string
  detail: string
  tone: 'good' | 'action' | 'warning'
  qualityScore: number
  brightnessLabel: string
  nextShot: string
}

export type ImagingRequest = {
  roomType: string
  listingGoal: string
  stylePreset: 'MLS Clean' | 'Luxury Editorial' | 'Bright Rental'
}

export type SessionInsight = {
  coverageScore: number
  lighting: 'dim' | 'balanced' | 'bright'
  dominantPalette: string[]
  recommendations: string[]
}

export type PhotoEditPlan = {
  preset: ImagingRequest['stylePreset']
  exposure: number
  contrast: number
  saturation: number
  warmth: number
  clarity: number
  verticalCorrection: number
  retouchInstructions: string[]
}

export type DetectedPhotoContent = {
  tags: string[]
  lighting: 'underexposed' | 'balanced' | 'overexposed' | 'high-dynamic-range'
  colorCast: 'cool' | 'neutral' | 'warm' | 'green' | 'magenta'
  detailLevel: 'low' | 'moderate' | 'high'
  windowConfidence: number
  shadowRisk: number
  highlightRisk: number
}

export type AiCorrectionPlan = {
  exposureLift: number
  shadowLift: number
  highlightRecovery: number
  whiteBalance: {
    redGain: number
    greenGain: number
    blueGain: number
  }
  vibrance: number
  clarity: number
  denoise: number
  sharpen: number
  upscaleMultiplier: number
  reasons: string[]
}

export type PhotoBrief = {
  shotId: string
  label: string
  purpose: string
}

export type AiPhotoSessionResult = {
  insight: SessionInsight
  editPlan: PhotoEditPlan
  marketingPrompt: string
  photoBriefs: PhotoBrief[]
  completedShots: number
}

export type StyledPhoto = {
  id: string
  shotId: string
  angleLabel: string
  dataUrl: string
  width: number
  height: number
  editSummary: string
  qualityScore: number
  bracketCount: number
  detectedContent: DetectedPhotoContent
  correctionPlan: AiCorrectionPlan
}
