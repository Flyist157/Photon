import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import './App.css'
import { analyzeLiveCameraFrame, mapSpaceWithAiBackend } from './lib/aiBackend'
import { buildRoomModel } from './lib/reconstruction'
import { generateListingPhotos, renderInteractivePreview } from './lib/render'
import type { AiPipelineResult, CaptureGuidance, CapturedFrame, ImagingRequest, RoomModel, StyledPhoto } from './types'

const CAPTURE_STEP_DEGREES = 45
const TARGET_CAPTURES = 8
const MINIMUM_CAPTURES = 6
const ROOM_TYPES = ['Living room', 'Bedroom', 'Kitchen', 'Bathroom', 'Office', 'Retail space', 'Interior room']
const STYLE_PRESETS: ImagingRequest['stylePreset'][] = ['MLS Clean', 'Luxury Editorial', 'Bright Rental']

type ScanState = 'idle' | 'scanning' | 'complete'
type AppStage = 'capture' | 'processing' | 'gallery'

type DeviceOrientationEventWithCompass = DeviceOrientationEvent & {
  webkitCompassHeading?: number
}

type DeviceOrientationPermissionEvent = typeof DeviceOrientationEvent & {
  requestPermission?: () => Promise<'granted' | 'denied'>
}

const normalizeHeading = (heading: number): number => {
  const normalized = heading % 360
  return normalized < 0 ? normalized + 360 : normalized
}

const headingDelta = (start: number, current: number): number =>
  normalizeHeading(current - start)

const circularDistance = (a: number, b: number): number => {
  const distance = Math.abs(normalizeHeading(a) - normalizeHeading(b))
  return Math.min(distance, 360 - distance)
}

function App() {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const previewCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const scanStartRef = useRef<number | null>(null)
  const nextAutoCaptureTargetRef = useRef<number>(CAPTURE_STEP_DEGREES)
  const framesRef = useRef<CapturedFrame[]>([])

  const [stage, setStage] = useState<AppStage>('capture')
  const [scanState, setScanState] = useState<ScanState>('idle')
  const [cameraReady, setCameraReady] = useState(false)
  const [heading, setHeading] = useState<number | null>(null)
  const [scanStartHeading, setScanStartHeading] = useState<number | null>(null)
  const [frames, setFrames] = useState<CapturedFrame[]>([])
  const [roomModel, setRoomModel] = useState<RoomModel | null>(null)
  const [photos, setPhotos] = useState<StyledPhoto[]>([])
  const [aiResult, setAiResult] = useState<AiPipelineResult | null>(null)
  const [liveGuidance, setLiveGuidance] = useState<CaptureGuidance | null>(null)
  const [imagingRequest, setImagingRequest] = useState<ImagingRequest>({
    roomType: 'Living room',
    listingGoal: 'Create bright, photorealistic listing photos that make the room feel spacious, clean, and true to life.',
    stylePreset: 'MLS Clean',
  })
  const [sensorEnabled, setSensorEnabled] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const sensorPermissionRequired =
    typeof DeviceOrientationEvent !== 'undefined' &&
    'requestPermission' in (DeviceOrientationEvent as DeviceOrientationPermissionEvent)
  const showSensorPermissionAction = sensorPermissionRequired && !sensorEnabled

  const captureFrame = useCallback(
    (forcedRelativeHeading?: number) => {
      const video = videoRef.current
      if (!video) {
        setError('Camera preview is not available yet.')
        return
      }

      const width = video.videoWidth
      const height = video.videoHeight
      if (!width || !height) {
        setError('Wait until the camera stream fully initializes before capturing.')
        return
      }

      const relativeHeading =
        forcedRelativeHeading ??
        (scanStartRef.current !== null && heading !== null
          ? headingDelta(scanStartRef.current, heading)
          : Math.min(framesRef.current.length * CAPTURE_STEP_DEGREES, 359))

      const previous = framesRef.current.at(-1)
      if (previous && circularDistance(previous.heading, relativeHeading) < 14) {
        return
      }

      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      const context = canvas.getContext('2d')
      if (!context) {
        setError('Unable to access image capture context.')
        return
      }

      context.drawImage(video, 0, 0, width, height)
      const imageDataUrl = canvas.toDataURL('image/jpeg', 0.97)
      const frame: CapturedFrame = {
        id: crypto.randomUUID(),
        heading: normalizeHeading(relativeHeading),
        imageDataUrl,
        width,
        height,
        capturedAt: Date.now(),
      }

      framesRef.current = [...framesRef.current, frame]
      setFrames(framesRef.current)
      setError(null)
    },
    [heading],
  )

  useEffect(() => {
    let mounted = true

    const initializeCamera = async (): Promise<void> => {
      if (!navigator.mediaDevices?.getUserMedia) {
        setError('This browser does not support live camera capture.')
        return
      }

      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: { ideal: 'environment' },
            width: { ideal: 3840 },
            height: { ideal: 2160 },
          },
          audio: false,
        })

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
        if (!sensorPermissionRequired) {
          setSensorEnabled(true)
        }
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
    }
  }, [sensorPermissionRequired])

  useEffect(() => {
    if (!sensorEnabled) {
      return
    }

    const onOrientation = (event: DeviceOrientationEventWithCompass): void => {
      let measuredHeading: number | null = null
      if (typeof event.webkitCompassHeading === 'number' && !Number.isNaN(event.webkitCompassHeading)) {
        measuredHeading = normalizeHeading(event.webkitCompassHeading)
      } else if (typeof event.alpha === 'number' && !Number.isNaN(event.alpha)) {
        measuredHeading = normalizeHeading(event.alpha)
      }

      if (measuredHeading === null) {
        return
      }

      setHeading(measuredHeading)
      if (scanState !== 'scanning' || scanStartRef.current === null) {
        return
      }

      const relative = headingDelta(scanStartRef.current, measuredHeading)
      if (relative + 1.5 >= nextAutoCaptureTargetRef.current && nextAutoCaptureTargetRef.current <= 360) {
        captureFrame(nextAutoCaptureTargetRef.current)
        nextAutoCaptureTargetRef.current += CAPTURE_STEP_DEGREES
      }

      if (relative >= 355 && framesRef.current.length >= TARGET_CAPTURES) {
        setScanState('complete')
      }
    }

    window.addEventListener('deviceorientation', onOrientation, true)
    return () => {
      window.removeEventListener('deviceorientation', onOrientation, true)
    }
  }, [captureFrame, scanState, sensorEnabled])

  const rotationDegrees = useMemo(() => {
    if (scanState === 'scanning' && scanStartHeading !== null && heading !== null) {
      return headingDelta(scanStartHeading, heading)
    }

    return Math.min((frames.length / TARGET_CAPTURES) * 360, 360)
  }, [frames.length, heading, scanStartHeading, scanState])

  const progressPercent = Math.round((Math.min(360, rotationDegrees) / 360) * 100)

  useEffect(() => {
    if (stage !== 'capture' || !cameraReady) {
      return
    }

    const updateGuidance = (): void => {
      const video = videoRef.current
      if (!video) {
        return
      }

      const guidance = analyzeLiveCameraFrame(video, framesRef.current.length, rotationDegrees)
      if (guidance) {
        setLiveGuidance(guidance)
      }
    }

    updateGuidance()
    const intervalId = window.setInterval(updateGuidance, 1200)
    return () => window.clearInterval(intervalId)
  }, [cameraReady, frames.length, rotationDegrees, stage])

  useEffect(() => {
    if (stage !== 'gallery' || !roomModel || !previewCanvasRef.current) {
      return
    }

    const canvas = previewCanvasRef.current
    let frameHandle = 0
    let yaw = 0

    const draw = (): void => {
      yaw += 0.35
      renderInteractivePreview(canvas, roomModel, yaw)
      frameHandle = window.requestAnimationFrame(draw)
    }

    draw()
    return () => window.cancelAnimationFrame(frameHandle)
  }, [roomModel, stage])

  const requestOrientationPermission = async (): Promise<void> => {
    const orientationConstructor = DeviceOrientationEvent as DeviceOrientationPermissionEvent
    if (!orientationConstructor.requestPermission) {
      setSensorEnabled(true)
      return
    }

    try {
      const result = await orientationConstructor.requestPermission()
      if (result === 'granted') {
        setSensorEnabled(true)
      } else {
        setError('Motion permission denied. Photon will run in manual capture mode.')
      }
    } catch {
      setError('Motion permission request failed. Continue with manual capture mode.')
    }
  }

  const startScan = (): void => {
    if (!cameraReady) {
      setError('Camera is still warming up.')
      return
    }

    framesRef.current = []
    setFrames([])
    setPhotos([])
    setRoomModel(null)
    setAiResult(null)
    setError(null)
    setStage('capture')
    setScanState('scanning')

    const start = heading ?? 0
    scanStartRef.current = start
    setScanStartHeading(start)
    nextAutoCaptureTargetRef.current = CAPTURE_STEP_DEGREES
    captureFrame(0)
  }

  const finishScan = (): void => {
    if (framesRef.current.length < MINIMUM_CAPTURES) {
      setError(`Capture at least ${MINIMUM_CAPTURES} viewpoints before processing.`)
      return
    }
    setScanState('complete')
  }

  const processScan = async (): Promise<void> => {
    if (frames.length < MINIMUM_CAPTURES) {
      setError(`Capture at least ${MINIMUM_CAPTURES} images before generating the 3D model.`)
      return
    }

    try {
      setStage('processing')
      setError(null)
      const model = await buildRoomModel(frames)
      const aiPipelineResult = await mapSpaceWithAiBackend(frames, model, imagingRequest)
      const listingPhotos = await generateListingPhotos(model, aiPipelineResult.editPlan, aiPipelineResult.photoBriefs)
      setRoomModel(model)
      setAiResult(aiPipelineResult)
      setPhotos(listingPhotos)
      setStage('gallery')
    } catch (scanError) {
      const message =
        scanError instanceof Error
          ? scanError.message
          : 'Photon could not reconstruct a model from this scan.'
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

  return (
    <main className="app-shell">
      <header className="card">
        <h1>Photon</h1>
        <p>
          Stand in the center of the room, hold your phone upright, and rotate in one slow 360° turn.
          Photon captures high-res room views, uses live prompts to guide coverage, maps the space with an
          AI-style backend pass, then edits photorealistic listing images from the reconstructed model.
        </p>
      </header>

      {error && <div className="error-banner">{error}</div>}

      {stage === 'capture' && (
        <section className="card">
          <h2>1) Guided Room Scan</h2>
          <p className="hint">
            Keep motion smooth. Photon captures frames automatically every 45° when sensor data is available.
          </p>

          <div className="prompt-panel">
            <label>
              Room type
              <select
                value={imagingRequest.roomType}
                onChange={(event) =>
                  setImagingRequest((current) => ({ ...current, roomType: event.target.value }))
                }
              >
                {ROOM_TYPES.map((roomType) => (
                  <option key={roomType} value={roomType}>
                    {roomType}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Real-time editing prompt
              <textarea
                value={imagingRequest.listingGoal}
                onChange={(event) =>
                  setImagingRequest((current) => ({ ...current, listingGoal: event.target.value }))
                }
                rows={3}
              />
            </label>
            <label>
              AI editing preset
              <select
                value={imagingRequest.stylePreset}
                onChange={(event) =>
                  setImagingRequest((current) => ({
                    ...current,
                    stylePreset: event.target.value as ImagingRequest['stylePreset'],
                  }))
                }
              >
                {STYLE_PRESETS.map((preset) => (
                  <option key={preset} value={preset}>
                    {preset}
                  </option>
                ))}
              </select>
            </label>
          </div>

          {showSensorPermissionAction && (
            <button className="secondary" onClick={() => void requestOrientationPermission()}>
              Enable motion guidance
            </button>
          )}

          <div className="preview-wrap">
            <video ref={videoRef} playsInline autoPlay muted />
          </div>

          {liveGuidance && (
            <div className={`guidance-card ${liveGuidance.tone}`}>
              <div>
                <span className="eyebrow">Live capture prompt</span>
                <strong>{liveGuidance.headline}</strong>
                <p>{liveGuidance.detail}</p>
              </div>
              <div className="guidance-stats">
                <span>{liveGuidance.qualityScore}% quality</span>
                <span>{liveGuidance.brightnessLabel} light</span>
                <span>{liveGuidance.nextShot}</span>
              </div>
            </div>
          )}

          <div className="progress-track" aria-label="Rotation progress">
            <div className="progress-fill" style={{ width: `${progressPercent}%` }} />
          </div>
          <div className="meta-row">
            <span>Rotation: {Math.round(rotationDegrees)}° / 360°</span>
            <span>Captured: {frames.length}</span>
          </div>

          <div className="button-row">
            <button onClick={startScan} disabled={!cameraReady || scanState === 'scanning'}>
              {scanState === 'idle' ? 'Start scan' : 'Restart scan'}
            </button>
            <button onClick={() => captureFrame()} disabled={scanState !== 'scanning'}>
              Capture now
            </button>
            <button onClick={finishScan} disabled={scanState !== 'scanning'}>
              Finish rotation
            </button>
          </div>

          <div className="button-row">
            <button
              className="primary"
              onClick={() => void processScan()}
              disabled={scanState !== 'complete'}
            >
              Build 3D model and generate photos
            </button>
          </div>
        </section>
      )}

      {stage === 'processing' && (
        <section className="card center">
          <h2>2) Mapping and editing with Photon AI</h2>
          <p>Compiling color + depth cues, estimating the room map, generating prompts, and rendering listing photos.</p>
        </section>
      )}

      {stage === 'gallery' && roomModel && (
        <section className="card">
          <h2>3) Final Photo Gallery</h2>
          <p className="hint">
            Source frames: {roomModel.sourceFrames} • Point cloud samples: {roomModel.points.length.toLocaleString()}
          </p>
          <canvas ref={previewCanvasRef} className="model-preview" width={520} height={280} />

          {aiResult && (
            <div className="ai-report">
              <div>
                <span className="eyebrow">Backend room map</span>
                <strong>
                  {aiResult.spaceMap.estimatedDimensions.widthMeters}m ×{' '}
                  {aiResult.spaceMap.estimatedDimensions.depthMeters}m ×{' '}
                  {aiResult.spaceMap.estimatedDimensions.heightMeters}m
                </strong>
                <p>
                  {aiResult.spaceMap.coverageScore}% coverage • {aiResult.spaceMap.lighting} lighting •{' '}
                  {Math.round(aiResult.spaceMap.estimatedDimensions.confidence * 100)}% map confidence
                </p>
              </div>
              <div className="palette-row">
                {aiResult.spaceMap.dominantPalette.map((color) => (
                  <span key={color} style={{ background: color }} title={color} />
                ))}
              </div>
              <ul>
                {aiResult.spaceMap.features.map((feature) => (
                  <li key={feature.label}>
                    <strong>{feature.label}</strong> ({Math.round(feature.confidence * 100)}%): {feature.evidence}
                  </li>
                ))}
              </ul>
              <p className="prompt-output">{aiResult.marketingPrompt}</p>
            </div>
          )}

          <div className="gallery-grid">
            {photos.map((photo) => (
              <article className="photo-card" key={photo.id}>
                <img src={photo.dataUrl} alt={`Photon output ${photo.angleLabel}`} />
                <div className="photo-meta">
                  <div>
                    <strong>{photo.angleLabel}</strong>
                    <p>{photo.editSummary}</p>
                    <span>{photo.qualityScore}% render confidence</span>
                  </div>
                  <button onClick={() => downloadImage(photo)}>Download</button>
                </div>
              </article>
            ))}
          </div>

          <div className="button-row">
            <button onClick={startScan}>Scan another room</button>
          </div>
        </section>
      )}
    </main>
  )
}

export default App
