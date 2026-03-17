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
  sourceFrames: number
  generatedAt: number
}

export type StyledPhoto = {
  id: string
  angleLabel: string
  dataUrl: string
  width: number
  height: number
}
