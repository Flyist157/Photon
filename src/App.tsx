import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import './App.css'
import {
  analyzeLiveCameraFrame,
  buildGuidedShotPlan,
  reviewPhotoSession,
  summarizeShotStatuses,
} from './lib/aiBackend'
import { generateHdrListingPhotos } from './lib/render'
import type {
  AiPhotoSessionResult,
  CaptureGuidance,
  CapturedFrame,
  ImagingRequest,
  ShotPosition,
  StyledPhoto,
} from './types'

const ROOM_TYPES = ['Living room', 'Bedroom', 'Kitchen', 'Bathroom', 'Office', 'Retail space', 'Interior room']
const STYLE_PRESETS: ImagingRequest['stylePreset'][] = ['MLS Clean', 'Luxury Editorial', 'Bright Rental']
const REQUIRED_SHOTS = 3
const HDR_BIASES: CapturedFrame['exposureBias'][] = [-1, 0, 1]

type AppStage = 'capture' | 'processing' | 'gallery'

const exposureLabel = (bias: CapturedFrame['exposureBias']): string => {
  if (bias < 0) {
    return 'highlight-safe'
  }
  if (bias > 0) {
    return 'shadow-lift'
  }
  return 'neutral'
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

function App() {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const framesRef = useRef<CapturedFrame[]>([])

  const [stage, setStage] = useState<AppStage>('capture')
  const [cameraReady, setCameraReady] = useState(false)
  const [sessionStarted, setSessionStarted] = useState(false)
  const [activeShotIndex, setActiveShotIndex] = useState(0)
  const [frames, setFrames] = useState<CapturedFrame[]>([])
  const [photos, setPhotos] = useState<StyledPhoto[]>([])
  const [sessionResult, setSessionResult] = useState<AiPhotoSessionResult | null>(null)
  const [liveGuidance, setLiveGuidance] = useState<CaptureGuidance | null>(null)
  const [capturing, setCapturing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [imagingRequest, setImagingRequest] = useState<ImagingRequest>({
    roomType: 'Living room',
    listingGoal: 'Create bright, accurate, professional listing photos that make the room feel spacious, clean, and true to life.',
    stylePreset: 'MLS Clean',
  })

  const shotPlan = useMemo(() => buildGuidedShotPlan(imagingRequest), [imagingRequest])
  const activeShot = shotPlan[activeShotIndex] ?? shotPlan[0]
  const shotStatuses = useMemo(() => summarizeShotStatuses(shotPlan, frames), [frames, shotPlan])
  const completedShots = shotStatuses.filter((shot) => shot.complete).length
  const completedRequiredShots = shotStatuses.filter((shot) => shot.priority === 'required' && shot.complete).length
  const activeShotStatus = shotStatuses[activeShotIndex] ?? shotStatuses[0]
  const progressPercent = Math.round((completedShots / shotPlan.length) * 100)
  const canGenerate = completedRequiredShots >= REQUIRED_SHOTS

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
            aspectRatio: { ideal: 16 / 9 },
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

  const captureBracket = useCallback(
    (shot: ShotPosition, bias: CapturedFrame['exposureBias']): CapturedFrame | null => {
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
      const biasedFrame = applyExposureBias(context.getImageData(0, 0, canvas.width, canvas.height), bias)
      context.putImageData(biasedFrame, 0, 0)

      return {
        id: crypto.randomUUID(),
        shotId: shot.id,
        shotLabel: shot.label,
        exposureBias: bias,
        heading: shot.targetHeading,
        imageDataUrl: canvas.toDataURL('image/jpeg', 0.97),
        width: canvas.width,
        height: canvas.height,
        capturedAt: Date.now(),
      }
    },
    [],
  )

  const startSession = (): void => {
    if (!cameraReady) {
      setError('Camera is still warming up.')
      return
    }

    framesRef.current = []
    setFrames([])
    setPhotos([])
    setSessionResult(null)
    setError(null)
    setStage('capture')
    setSessionStarted(true)
    setActiveShotIndex(0)
  }

  const captureHdrBurst = async (): Promise<void> => {
    if (!sessionStarted) {
      startSession()
    }
    if (!activeShot) {
      return
    }

    setCapturing(true)
    setError(null)

    const keptFrames = framesRef.current.filter((frame) => frame.shotId !== activeShot.id)
    const capturedFrames: CapturedFrame[] = []
    for (const bias of HDR_BIASES) {
      const frame = captureBracket(activeShot, bias)
      if (frame) {
        capturedFrames.push(frame)
      }
      await wait(90)
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

  const processPhotos = async (): Promise<void> => {
    if (!canGenerate) {
      setError(`Capture the ${REQUIRED_SHOTS} required HDR positions before generating photos.`)
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

      {stage === 'capture' && (
        <section className="card">
          <h2>1) Guided HDR photo positions</h2>
          <p className="hint">
            Hold the phone landscape at chest height. Capture the three required positions first, then add
            recommended angles for a stronger listing set.
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
              Editing goal
              <textarea
                value={imagingRequest.listingGoal}
                onChange={(event) =>
                  setImagingRequest((current) => ({ ...current, listingGoal: event.target.value }))
                }
                rows={3}
              />
            </label>
            <label>
              Photo style
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

          <div className="preview-wrap">
            <video ref={videoRef} playsInline autoPlay muted />
          </div>

          {activeShot && (
            <article className="shot-card">
              <div>
                <span className="eyebrow">Current position</span>
                <h3>{activeShot.label}</h3>
                <p>{activeShot.placement}</p>
              </div>
              <ul>
                <li>{activeShot.composition}</li>
                <li>{activeShot.coaching}</li>
                <li>HDR burst: {HDR_BIASES.map(exposureLabel).join(' + ')}</li>
              </ul>
            </article>
          )}

          {liveGuidance && (
            <div className={`guidance-card ${liveGuidance.tone}`}>
              <div>
                <span className="eyebrow">Live photo coach</span>
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

          <div className="progress-track" aria-label="Shot coverage progress">
            <div className="progress-fill" style={{ width: `${progressPercent}%` }} />
          </div>
          <div className="meta-row">
            <span>
              Required: {completedRequiredShots}/{REQUIRED_SHOTS}
            </span>
            <span>
              Total positions: {completedShots}/{shotPlan.length}
            </span>
          </div>

          <div className="shot-list">
            {shotStatuses.map((shot, index) => (
              <button
                className={`shot-list-item ${index === activeShotIndex ? 'active' : ''} ${shot.complete ? 'complete' : ''}`}
                key={shot.id}
                onClick={() => setActiveShotIndex(index)}
              >
                <span>{shot.label}</span>
                <small>
                  {shot.priority} • {shot.capturedBrackets}/3 brackets
                </small>
              </button>
            ))}
          </div>

          <div className="button-row">
            <button onClick={startSession} disabled={!cameraReady || capturing}>
              {sessionStarted ? 'Restart photo session' : 'Start photo session'}
            </button>
            <button
              onClick={() => setActiveShotIndex((index) => Math.max(0, index - 1))}
              disabled={activeShotIndex === 0 || capturing}
            >
              Previous position
            </button>
            <button
              onClick={() => setActiveShotIndex((index) => Math.min(shotPlan.length - 1, index + 1))}
              disabled={activeShotIndex === shotPlan.length - 1 || capturing}
            >
              Next position
            </button>
          </div>

          <div className="button-row">
            <button className="primary" onClick={() => void captureHdrBurst()} disabled={!cameraReady || capturing}>
              {capturing ? 'Capturing HDR burst...' : 'Capture wide-angle HDR'}
            </button>
            <button className="secondary" onClick={clearCurrentShot} disabled={capturing || !activeShotStatus?.capturedBrackets}>
              Retake current
            </button>
            <button className="primary" onClick={() => void processPhotos()} disabled={!canGenerate || capturing}>
              Generate enhanced listing photos
            </button>
          </div>
        </section>
      )}

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
            <button onClick={startSession}>Capture another room</button>
          </div>
        </section>
      )}
    </main>
  )
}

export default App
