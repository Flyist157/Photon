export type CapturedFrame = {
  id: string
  heading: number
  imageDataUrl: string
  width: number
  height: number
  capturedAt: number
}

export type Point3D = {
  x: number
  y: number
  z: number
  r: number
  g: number
  b: number
}

export type RoomModel = {
  points: Point3D[]
  sourceFrameData: CapturedFrame[]
  sourceFrames: number
  generatedAt: number
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

export type SpaceFeature = {
  label: string
  confidence: number
  evidence: string
}

export type SpaceMap = {
  estimatedDimensions: {
    widthMeters: number
    depthMeters: number
    heightMeters: number
    confidence: number
  }
  coverageScore: number
  lighting: 'dim' | 'balanced' | 'bright'
  dominantPalette: string[]
  features: SpaceFeature[]
  captureNotes: string[]
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

export type PhotoBrief = {
  label: string
  yawDegrees: number
  purpose: string
}

export type AiPipelineResult = {
  spaceMap: SpaceMap
  editPlan: PhotoEditPlan
  marketingPrompt: string
  photoBriefs: PhotoBrief[]
}

export type StyledPhoto = {
  id: string
  angleLabel: string
  dataUrl: string
  width: number
  height: number
  editSummary: string
  qualityScore: number
}
