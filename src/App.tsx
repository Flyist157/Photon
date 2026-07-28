import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import './App.css'
import {
  analyzeLiveCameraFrame,
  buildGuidedShotPlan,
  reviewPhotoSession,
  summarizeShotStatuses,
} from './lib/aiBackend'
import { clamp } from './lib/image'
import { generateHdrListingPhotos } from './lib/render'
import type {
  AiPhotoSessionResult,
  CaptureGuidance,
  CapturedFrame,
  ImagingRequest,
  PropertyCapturePlan,
  ShotPosition,
  StyledPhoto,
} from './types'

const HDR_BIASES: CapturedFrame['exposureBias'][] = [-1, 0, 1]
const CAPTURE_PLAN_FIELDS: { key: keyof PropertyCapturePlan; label: string; min: number; max: number }[] = [
  { key: 'livingRooms', label: 'Living / great rooms', min: 0, max: 6 },
  { key: 'kitchens', label: 'Kitchens', min: 0, max: 4 },
  { key: 'bedrooms', label: 'Bedrooms', min: 0, max: 12 },
  { key: 'bathrooms', label: 'Bathrooms', min: 0, max: 10 },
  { key: 'yards', label: 'Yards / outdoor areas', min: 0, max: 6 },
  { key: 'exteriorAngles', label: 'Exterior angles', min: 0, max: 8 },
]

type AppStage = 'intro' | 'capture' | 'processing' | 'gallery'

type BaseCapture = {
  imageData: ImageData
  width: number
  height: number
}

type CameraCapabilities = MediaTrackCapabilities & {
  exposureMode?: string[]
  exposureCompensation?: {
    min: number
    max: number
    step?: number
  }
  zoom?: {
    min: number
    max: number
    step?: number
  }
}

type CameraSettings = MediaTrackSettings & {
  exposureCompensation?: number
  zoom?: number
}

type AdvancedCameraConstraints = MediaTrackConstraintSet & {
  exposureMode?: string
  exposureCompensation?: number
  zoom?: number
}

const applyExposureBias = (
  imageData: ImageData,
  bias: CapturedFrame['exposureBias'],
): ImageData => {
  const factor = bias === -1 ? 0.68 : bias === 1 ? 1.38 : 1
  const output = new Uint8ClampedArray(imageData.data)

  for (let i = 0; i < output.length; i += 4) {
    output[i] = Math.min(255, Math.round(output[i] * factor))
    output[i + 1] = Math.min(255, Math.round(output[i + 1] * factor))
    output[i + 2] = Math.min(255, Math.round(output[i + 2] * factor))
  }

  return new ImageData(output, imageData.width, imageData.height)
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => window.setTimeout(resolve, ms))

const baseCameraConstraints = {
  facingMode: { ideal: 'environment' },
  width: { ideal: 3840 },
  height: { ideal: 2160 },
  aspectRatio: { ideal: 16 / 9 },
}

const isUltraWideLabel = (label: string): boolean =>
  /ultra|0\.5|0,5|wide angle|ultrawide/i.test(label)

const configureWidestLens = async (stream: MediaStream): Promise<string | null> => {
  const track = stream.getVideoTracks()[0]
  if (!track?.getCapabilities) {
    return null
  }

  const capabilities = track.getCapabilities() as CameraCapabilities
  if (!capabilities.zoom) {
    return null
  }

  const constraints: AdvancedCameraConstraints = {
    zoom: capabilities.zoom.min,
  }
  await track.applyConstraints({ advanced: [constraints] })
  return null
}

const getBestWideCameraStream = async (): Promise<{ stream: MediaStream; note: string | null }> => {
  const initialStream = await navigator.mediaDevices.getUserMedia({
    video: baseCameraConstraints,
    audio: false,
  })

  const devices = await navigator.mediaDevices.enumerateDevices().catch(() => [])
  const ultraWideDevice = devices.find(
    (device) => device.kind === 'videoinput' && isUltraWideLabel(device.label),
  )

  let stream = initialStream
  let note: string | null = null
  if (ultraWideDevice?.deviceId) {
    initialStream.getTracks().forEach((track) => track.stop())
    stream = await navigator.mediaDevices.getUserMedia({
      video: {
        ...baseCameraConstraints,
        deviceId: { exact: ultraWideDevice.deviceId },
      },
      audio: false,
    })
    note = `Using ${ultraWideDevice.label}.`
  }

  const zoomNote = await configureWidestLens(stream).catch(() => null)
  return {
    stream,
    note: note ?? zoomNote,
  }
}

function App() {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const framesRef = useRef<CapturedFrame[]>([])

  const [stage, setStage] = useState<AppStage>('intro')
  const [cameraReady, setCameraReady] = useState(false)
  const [sessionStarted, setSessionStarted] = useState(false)
  const [activeShotIndex, setActiveShotIndex] = useState(0)
  const [frames, setFrames] = useState<CapturedFrame[]>([])
  const [photos, setPhotos] = useState<StyledPhoto[]>([])
  const [sessionResult, setSessionResult] = useState<AiPhotoSessionResult | null>(null)
  const [liveGuidance, setLiveGuidance] = useState<CaptureGuidance | null>(null)
  const [capturing, setCapturing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [cameraNote, setCameraNote] = useState<string | null>(null)
  const [exposureLocked, setExposureLocked] = useState(false)
  const [isPortrait, setIsPortrait] = useState(false)
  const [imagingRequest] = useState<ImagingRequest>({
    roomType: 'Living room',
    listingGoal: 'Create bright, accurate, professional listing photos that make the room feel spacious, clean, and true to life.',
    stylePreset: 'MLS Clean',
  })
  const [propertyPlan, setPropertyPlan] = useState<PropertyCapturePlan>({
    livingRooms: 1,
    kitchens: 1,
    bedrooms: 3,
    bathrooms: 2,
    yards: 1,
    exteriorAngles: 4,
  })

  const shotPlan = useMemo(() => buildGuidedShotPlan(imagingRequest, propertyPlan), [imagingRequest, propertyPlan])
  const activeShot = shotPlan[activeShotIndex] ?? shotPlan[0]
  const shotStatuses = useMemo(() => summarizeShotStatuses(shotPlan, frames), [frames, shotPlan])
  const completedShots = shotStatuses.filter((shot) => shot.complete).length
  const completedRequiredShots = shotStatuses.filter((shot) => shot.priority === 'required' && shot.complete).length
  const requiredShotTotal = shotStatuses.filter((shot) => shot.priority === 'required').length
  const activeShotStatus = shotStatuses[activeShotIndex] ?? shotStatuses[0]
  const progressPercent = shotPlan.length ? Math.round((completedShots / shotPlan.length) * 100) : 0
  const canGenerate = requiredShotTotal > 0 && completedRequiredShots >= requiredShotTotal

  useEffect(() => {
    if (stage !== 'capture') {
      return
    }

    let mounted = true

    const initializeCamera = async (): Promise<void> => {
      if (!navigator.mediaDevices?.getUserMedia) {
        setError('This browser does not support live camera capture. Use Safari/Chrome over HTTPS.')
        return
      }

      try {
        const { stream, note } = await getBestWideCameraStream()

        if (!mounted) {
          stream.getTracks().forEach((track) => track.stop())
          return
        }

        streamRef.current = stream
        const video = videoRef.current
        if (video) {
          video.srcObject = stream
          await video.play().catch(() => undefined)
        }

        setCameraReady(true)
        setCameraNote(note)
      } catch {
        setError('Camera access failed. Allow camera permission and reload Photon.')
      }
    }

    void initializeCamera()
    return () => {
      mounted = false
      const stream = streamRef.current
      stream?.getTracks().forEach((track) => track.stop())
      streamRef.current = null
      setCameraReady(false)
      setExposureLocked(false)
    }
  }, [stage])

  useEffect(() => {
    const updateOrientation = (): void => {
      setIsPortrait(window.innerHeight > window.innerWidth)
    }

    updateOrientation()
    window.addEventListener('resize', updateOrientation)
    window.addEventListener('orientationchange', updateOrientation)
    return () => {
      window.removeEventListener('resize', updateOrientation)
      window.removeEventListener('orientationchange', updateOrientation)
    }
  }, [])

  useEffect(() => {
    if (stage !== 'capture' || !cameraReady || !activeShot) {
      return
    }

    const updateGuidance = (): void => {
      const video = videoRef.current
      if (!video) {
        return
      }

      const guidance = analyzeLiveCameraFrame(video, activeShot, activeShotStatus?.capturedBrackets ?? 0)
      if (guidance) {
        setLiveGuidance(guidance)
      }
    }

    updateGuidance()
    const intervalId = window.setInterval(updateGuidance, 1200)
    return () => window.clearInterval(intervalId)
  }, [activeShot, activeShotStatus?.capturedBrackets, cameraReady, stage])

  const captureBaseFrame = useCallback(
    (): BaseCapture | null => {
      const video = videoRef.current
      if (!video?.videoWidth || !video.videoHeight) {
        setError('Wait until the camera stream fully initializes before capturing.')
        return null
      }

      const canvas = document.createElement('canvas')
      canvas.width = video.videoWidth
      canvas.height = video.videoHeight
      const context = canvas.getContext('2d')
      if (!context) {
        setError('Unable to access image capture context.')
        return null
      }

      context.drawImage(video, 0, 0, canvas.width, canvas.height)
      return {
        imageData: context.getImageData(0, 0, canvas.width, canvas.height),
        width: canvas.width,
        height: canvas.height,
      }
    },
    [],
  )

  const createBracketFrame = useCallback(
    (shot: ShotPosition, baseCapture: BaseCapture, bias: CapturedFrame['exposureBias']): CapturedFrame | null => {
      const canvas = document.createElement('canvas')
      canvas.width = baseCapture.width
      canvas.height = baseCapture.height
      const context = canvas.getContext('2d')
      if (!context) {
        setError('Unable to access image capture context.')
        return null
      }

      const baseImageData = new ImageData(
        new Uint8ClampedArray(baseCapture.imageData.data),
        baseCapture.width,
        baseCapture.height,
      )
      const biasedFrame = applyExposureBias(baseImageData, bias)
      context.putImageData(biasedFrame, 0, 0)

      return {
        id: crypto.randomUUID(),
        shotId: shot.id,
        shotLabel: shot.label,
        exposureBias: bias,
        heading: shot.targetHeading,
        imageDataUrl: canvas.toDataURL('image/jpeg', 0.97),
        width: baseCapture.width,
        height: baseCapture.height,
        capturedAt: Date.now(),
      }
    },
    [],
  )

  const beginCaptureExperience = async (): Promise<void> => {
    framesRef.current = []
    setFrames([])
    setPhotos([])
    setSessionResult(null)
    setSessionStarted(true)
    setActiveShotIndex(0)
    setError(null)
    setCameraNote(null)
    setCameraReady(false)
    setStage('capture')

    await document.documentElement.requestFullscreen?.().catch(() => undefined)
    const orientation = screen.orientation as ScreenOrientation & {
      lock?: (orientation: string) => Promise<void>
    }
    await orientation.lock?.('landscape').catch(() => {
      setCameraNote('Rotate your phone to landscape if your browser does not lock orientation automatically.')
    })
  }

  const lockExposure = async (): Promise<void> => {
    const track = streamRef.current?.getVideoTracks()[0]
    if (!track?.getCapabilities) {
      setCameraNote('Exposure lock is not exposed by this browser. Hold steady before capture.')
      return
    }

    const capabilities = track.getCapabilities() as CameraCapabilities
    const settings = track.getSettings() as CameraSettings
    const constraints: AdvancedCameraConstraints = {}

    if (capabilities.exposureMode?.includes('manual')) {
      constraints.exposureMode = 'manual'
    }
    if (capabilities.exposureCompensation) {
      constraints.exposureCompensation = clamp(
        settings.exposureCompensation ?? 0,
        capabilities.exposureCompensation.min,
        capabilities.exposureCompensation.max,
      )
    }

    if (!Object.keys(constraints).length) {
      setCameraNote('Exposure lock is not supported by this browser/camera. Photon will still HDR-merge brackets.')
      return
    }

    await track.applyConstraints({ advanced: [constraints] })
    setExposureLocked(true)
    setCameraNote('Exposure locked for consistent HDR brackets.')
  }

  const captureHdrBurst = async (): Promise<void> => {
    if (!sessionStarted) {
      setSessionStarted(true)
    }
    if (!activeShot) {
      return
    }

    setCapturing(true)
    setError(null)

    const baseCapture = captureBaseFrame()
    if (!baseCapture) {
      setCapturing(false)
      return
    }

    const keptFrames = framesRef.current.filter((frame) => frame.shotId !== activeShot.id)
    const capturedFrames: CapturedFrame[] = []
    for (const bias of HDR_BIASES) {
      const frame = createBracketFrame(activeShot, baseCapture, bias)
      if (frame) {
        capturedFrames.push(frame)
      }
      await wait(35)
    }

    if (capturedFrames.length === HDR_BIASES.length) {
      const nextFrames = [...keptFrames, ...capturedFrames]
      framesRef.current = nextFrames
      setFrames(nextFrames)
      const nextIndex = shotPlan.findIndex(
        (shot, index) => index > activeShotIndex && !nextFrames.some((frame) => frame.shotId === shot.id),
      )
      if (nextIndex >= 0) {
        setActiveShotIndex(nextIndex)
      }
    }

    setCapturing(false)
  }

  const clearCurrentShot = (): void => {
    if (!activeShot) {
      return
    }

    const nextFrames = framesRef.current.filter((frame) => frame.shotId !== activeShot.id)
    framesRef.current = nextFrames
    setFrames(nextFrames)
  }

  const goToPreviousShot = (): void => {
    setActiveShotIndex(Math.max(0, activeShotIndex - 1))
  }

  const goToNextShot = (): void => {
    setActiveShotIndex(Math.min(shotPlan.length - 1, activeShotIndex + 1))
  }

  const processPhotos = async (): Promise<void> => {
    if (!canGenerate) {
      setError(`Capture the ${requiredShotTotal} required HDR positions before generating photos.`)
      return
    }

    try {
      setStage('processing')
      setError(null)
      const result = await reviewPhotoSession(frames, shotPlan, imagingRequest)
      const enhancedPhotos = await generateHdrListingPhotos(frames, result.editPlan, result.photoBriefs)
      setSessionResult(result)
      setPhotos(enhancedPhotos)
      setStage('gallery')
    } catch (photoError) {
      const message = photoError instanceof Error ? photoError.message : 'Photon could not render HDR listing photos.'
      setError(message)
      setStage('capture')
    }
  }

  const downloadImage = (photo: StyledPhoto): void => {
    const link = document.createElement('a')
    link.href = photo.dataUrl
    link.download = `photon-${photo.angleLabel.toLowerCase().replace(/\s+/g, '-')}.jpg`
    link.click()
  }

  const updatePropertyPlan = (key: keyof PropertyCapturePlan, delta: number): void => {
    const field = CAPTURE_PLAN_FIELDS.find((item) => item.key === key)
    if (!field) {
      return
    }

    setPropertyPlan((current) => ({
      ...current,
      [key]: clamp(current[key] + delta, field.min, field.max),
    }))
  }

  if (stage === 'intro') {
    return (
      <main className="intro-screen">
        <section className="intro-card">
          <span className="eyebrow">Photon</span>
          <h1>Build your shot list.</h1>
          <p>
            Tell Photon what spaces to capture. The app will guide you from interior rooms to yard and
            exterior angles, then capture wide HDR brackets for each shot.
          </p>

          <div className="plan-grid">
            {CAPTURE_PLAN_FIELDS.map((field) => (
              <div className="plan-row" key={field.key}>
                <span>{field.label}</span>
                <div className="stepper">
                  <button onClick={() => updatePropertyPlan(field.key, -1)} disabled={propertyPlan[field.key] <= field.min}>
                    -
                  </button>
                  <strong>{propertyPlan[field.key]}</strong>
                  <button onClick={() => updatePropertyPlan(field.key, 1)} disabled={propertyPlan[field.key] >= field.max}>
                    +
                  </button>
                </div>
              </div>
            ))}
          </div>

          <p className="plan-summary">
            {shotPlan.length} guided angles • {requiredShotTotal} required captures • interior to exterior workflow
          </p>
          <button className="primary intro-button" onClick={() => void beginCaptureExperience()} disabled={!requiredShotTotal}>
            Begin
          </button>
        </section>
      </main>
    )
  }

  if (stage === 'capture') {
    return (
      <main className="capture-shell">
        <video className="capture-video" ref={videoRef} playsInline autoPlay muted />

        <header className="capture-header">
          <div>
            <span className="eyebrow">Current room</span>
            <strong>{activeShot?.roomLabel ?? 'Property'}</strong>
            <span>{activeShot?.zone === 'exterior' ? 'Exterior' : 'Interior'}</span>
          </div>
          <div className="capture-header-actions">
            <span>
              {completedRequiredShots}/{requiredShotTotal} required
            </span>
            <button onClick={() => void lockExposure()} disabled={!cameraReady || exposureLocked}>
              {exposureLocked ? 'Exposure locked' : 'Lock exposure'}
            </button>
          </div>
        </header>

        {isPortrait && (
          <div className="rotate-overlay">
            <strong>Rotate to landscape</strong>
            <p>Photon captures listing photos horizontally for a wider, professional frame.</p>
          </div>
        )}

        {error && <div className="capture-alert">{error}</div>}
        {(cameraNote || !cameraReady) && (
          <div className="camera-note">{cameraNote ?? 'Starting camera...'}</div>
        )}

        <footer className="capture-footer">
          {activeShot && (
            <div className="angle-panel">
              <span className="eyebrow">Angle needed</span>
              <h2>{activeShot.label}</h2>
              <p>{activeShot.composition}</p>
              {liveGuidance && (
                <span className={`mini-guidance ${liveGuidance.tone}`}>
                  {liveGuidance.headline} • {liveGuidance.brightnessLabel} • {liveGuidance.qualityScore}%
                </span>
              )}
            </div>
          )}

          <div className="capture-progress">
            <div className="progress-track" aria-label="Shot coverage progress">
              <div className="progress-fill" style={{ width: `${progressPercent}%` }} />
            </div>
            <span>
              Required: {completedRequiredShots}/{requiredShotTotal} •{' '}
              {activeShotStatus?.capturedBrackets ?? 0}/3 HDR brackets for this angle
            </span>
          </div>

          <div className="capture-controls">
            <button className="ghost" onClick={goToPreviousShot} disabled={activeShotIndex === 0 || capturing}>
              Previous
            </button>
            <button className="capture-button" onClick={() => void captureHdrBurst()} disabled={!cameraReady || capturing || !activeShot}>
              {capturing ? 'Capturing' : cameraReady ? 'Capture' : 'Camera'}
            </button>
            <button
              className="ghost"
              onClick={goToNextShot}
              disabled={activeShotIndex === shotPlan.length - 1 || capturing}
            >
              Next
            </button>
          </div>

          <div className="capture-secondary-actions">
            <button onClick={clearCurrentShot} disabled={capturing || !activeShotStatus?.capturedBrackets}>
              Retake
            </button>
            <button className="primary" onClick={() => void processPhotos()} disabled={!canGenerate || capturing}>
              Generate photos
            </button>
          </div>
        </footer>
      </main>
    )
  }

  return (
    <main className="app-shell">
      <header className="card">
        <h1>Photon</h1>
        <p>
          Guided real-estate capture for phones. Photon coaches you to the best room positions, captures
          wide-angle HDR brackets, and turns them into polished listing-ready photos.
        </p>
      </header>

      {error && <div className="error-banner">{error}</div>}

      {stage === 'processing' && (
        <section className="card center">
          <h2>2) Merging HDR brackets</h2>
          <p>Combining highlight, neutral, and shadow brackets, correcting color, and preparing MLS-ready photos.</p>
        </section>
      )}

      {stage === 'gallery' && sessionResult && (
        <section className="card">
          <h2>3) Enhanced Listing Photo Gallery</h2>
          <p className="hint">
            HDR positions: {sessionResult.completedShots} • Coverage score: {sessionResult.insight.coverageScore}% •{' '}
            Lighting: {sessionResult.insight.lighting}
          </p>

          <div className="session-report">
            <div>
              <span className="eyebrow">Photo session review</span>
              <strong>{sessionResult.marketingPrompt}</strong>
            </div>
            <div className="palette-row">
              {sessionResult.insight.dominantPalette.map((color) => (
                <span key={color} style={{ background: color }} title={color} />
              ))}
            </div>
            <ul>
              {sessionResult.insight.recommendations.map((recommendation) => (
                <li key={recommendation}>{recommendation}</li>
              ))}
            </ul>
          </div>

          <div className="gallery-grid">
            {photos.map((photo) => {
              const detectedContent = photo.detectedContent
              const correctionReasons = photo.correctionPlan?.reasons.slice(1) ?? []

              return (
                <article className="photo-card" key={photo.id}>
                  <img src={photo.dataUrl} alt={`Photon HDR output ${photo.angleLabel}`} />
                  <div className="photo-meta">
                    <div>
                      <strong>{photo.angleLabel}</strong>
                      <p>{photo.editSummary}</p>
                      <p>
                        Detected:{' '}
                        {detectedContent
                          ? `${detectedContent.tags.join(', ')} • ${detectedContent.lighting} • ${detectedContent.colorCast} color`
                          : 'photo content awaiting analysis'}
                      </p>
                      <p>
                        Edits:{' '}
                        {correctionReasons.length
                          ? correctionReasons.join(' • ')
                          : 'HDR merge, color correction, sharpening, and export upscaling'}
                      </p>
                      <span>
                        {photo.bracketCount} HDR brackets • {photo.width}×{photo.height} upscaled JPG •{' '}
                        {photo.qualityScore}% output confidence
                      </span>
                    </div>
                    <button onClick={() => downloadImage(photo)}>Download</button>
                  </div>
                </article>
              )
            })}
          </div>

          <div className="button-row">
            <button onClick={() => void beginCaptureExperience()}>Capture another room</button>
          </div>
        </section>
      )}
    </main>
  )
}

export default App
