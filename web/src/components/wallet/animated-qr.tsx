import { useEffect, useMemo, useState } from "react"
import QRCode from "qrcode"

// Animated QR for long payloads (farm tokens run kilobytes): the token
// is chunked across frames, each frame a self-describing QR
// ("FARMQR i/N:<chunk>"), cycled fast enough for a scanning kiosk to
// reassemble in a few seconds. Single-frame payloads render static.
const CHUNK = 220
const FRAME_MS = 320

export function encodeQrFrames(payload: string): string[] {
  if (payload.length <= CHUNK) return [payload]
  const chunks: string[] = []
  for (let i = 0; i < payload.length; i += CHUNK) {
    chunks.push(payload.slice(i, i + CHUNK))
  }
  const n = chunks.length
  return chunks.map((c, i) => `FARMQR ${i + 1}/${n}:${c}`)
}

export function decodeQrFrames(frames: string[]): string | null {
  if (frames.length === 1 && !/^FARMQR 1\/1:/.test(frames[0])) return frames[0]
  const parts = new Map<number, string>()
  let total = 0
  for (const f of frames) {
    const m = f.match(/^FARMQR (\d+)\/(\d+):/)
    if (!m) continue
    total = Number(m[2])
    parts.set(Number(m[1]), f.slice(m[0].length))
  }
  if (total === 0 || parts.size !== total) return null
  return Array.from({ length: total }, (_, i) => parts.get(i + 1) ?? "").join("")
}

export function AnimatedQr({ payload, size = 230 }: { payload: string; size?: number }) {
  const frames = useMemo(() => encodeQrFrames(payload), [payload])
  const [idx, setIdx] = useState(0)
  const [src, setSrc] = useState<string | null>(null)

  useEffect(() => {
    if (frames.length < 2) return
    const t = window.setInterval(() => setIdx(i => (i + 1) % frames.length), FRAME_MS)
    return () => window.clearInterval(t)
  }, [frames.length])

  useEffect(() => {
    let alive = true
    QRCode.toDataURL(frames[idx] ?? "", { margin: 1, width: size * 2, errorCorrectionLevel: "L" })
      .then(d => { if (alive) setSrc(d) })
      .catch(() => { if (alive) setSrc(null) })
    return () => { alive = false }
  }, [frames, idx, size])

  if (!src) return null
  return (
    <div className="relative grid justify-items-center gap-1">
      <img
        src={src}
        alt={`Transfer QR — frame ${idx + 1} of ${frames.length}`}
        width={size}
        height={size}
        className="rounded-md bg-white p-2"
      />
      <span className="text-[10px] text-muted-foreground tabular-nums">
        animated transfer code — frame {idx + 1}/{frames.length}
      </span>
    </div>
  )
}
