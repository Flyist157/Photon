export const loadImage = (dataUrl: string): Promise<HTMLImageElement> =>
  new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('Failed to decode captured image.'))
    image.src = dataUrl
  })

export const drawToCanvas = (
  image: CanvasImageSource,
  width: number,
  height: number,
): HTMLCanvasElement => {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d')
  if (!context) {
    throw new Error('Could not initialize 2D drawing context.')
  }

  context.drawImage(image, 0, 0, width, height)
  return canvas
}

export const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value))
