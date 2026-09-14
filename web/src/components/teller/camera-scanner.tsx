import { useEffect, useRef, useState } from "react"
import { Camera, CameraOff, Loader2 } from "lucide-react"

import { Button } from "@/components/ui/button"

type DetectedBarcode = { rawValue: string }
type BarcodeDetectorLike = { detect(source: CanvasImageSource): Promise<DetectedBarcode[]> }
type BarcodeDetectorCtor = new (options?: { formats?: string[] }) => BarcodeDetectorLike

/**
 * Live QR scan off the operator's webcam: the customer holds up their
 * wallet's "Teller code" QR, we decode it with the platform BarcodeDetector
 * and hand the payload to `onCode`. The server's match input normalizes
 * whatever the code contains (full quote id or tail), so no client-side
 * parsing beyond a trim.
 */
export function CameraScanner({
  onCode,
  onCancel,
}: {
  onCode: (payload: string) => void
  onCancel: () => void
}) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const onCodeRef = useRef(onCode)
  onCodeRef.current = onCode
  const [starting, setStarting] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let stream: MediaStream | null = null
    let timer: number | undefined
    let settled = false

    const Ctor = (window as unknown as { BarcodeDetector?: BarcodeDetectorCtor })
      .BarcodeDetector
    if (!Ctor) {
      setStarting(false)
      setError("This browser can't decode QR codes — type the code instead.")
      return
    }
    const detector = new Ctor({ formats: ["qr_code"] })

    void navigator.mediaDevices
      .getUserMedia({ video: { facingMode: "environment" } })
      .then((mediaStream) => {
        if (settled) {
          mediaStream.getTracks().forEach((track) => track.stop())
          return
        }
        stream = mediaStream
        const video = videoRef.current
        if (!video) return
        video.srcObject = mediaStream
        setStarting(false)
        void video.play()
        timer = window.setInterval(() => {
          const element = videoRef.current
          if (!element || element.readyState < 2) return
          void detector
            .detect(element)
            .then((codes) => {
              const hit = codes
                .map((code) => code.rawValue.trim())
                .find((raw) => raw.length >= 6)
              if (hit && !settled) {
                settled = true
                onCodeRef.current(hit)
              }
            })
            .catch(() => undefined)
        }, 300)
      })
      .catch(() => {
        setStarting(false)
        setError("Camera unavailable — grant permission (or type the code instead).")
      })

    return () => {
      settled = true
      if (timer !== undefined) window.clearInterval(timer)
      stream?.getTracks().forEach((track) => track.stop())
    }
  }, [])

  return (
    <div className="grid gap-3">
      <div className="relative overflow-hidden rounded-md border bg-black">
        <video
          ref={videoRef}
          muted
          playsInline
          className="aspect-video w-full object-cover"
        />
        {starting && (
          <div className="absolute inset-0 grid place-items-center bg-black/60 text-muted-foreground">
            <span className="inline-flex items-center gap-2 text-sm">
              <Loader2 className="size-4 animate-spin" />
              Starting camera…
            </span>
          </div>
        )}
        {error && (
          <div className="absolute inset-0 grid place-items-center bg-black/80 p-4 text-center text-sm text-muted-foreground">
            <span className="inline-flex items-start gap-2">
              <CameraOff className="mt-0.5 size-4 shrink-0" />
              {error}
            </span>
          </div>
        )}
      </div>
      <p className="text-center text-sm text-muted-foreground">
        Ask the customer to hold up their wallet — the QR encodes the quote id.
      </p>
      <Button type="button" variant="outline" onClick={onCancel}>
        <Camera />
        Stop camera
      </Button>
    </div>
  )
}
