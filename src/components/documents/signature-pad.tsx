import { Eraser } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'

/*
 * The signature of the customer, drawn with a finger on the screen. A canvas with a white background that is exported as a
 * JPEG (what the PDF takes) after every stroke, so the draft always holds the signature as it is now. Touch, pen and mouse
 * all go through pointer events; `touch-action: none` keeps the page from scrolling while someone signs.
 *
 * Drawing cannot be done with the keyboard, so there is no keyboard way to sign: the canvas can be focused (for the "go to
 * the first wrong field" step) and the button below it clears it.
 */

const INK = '#16283C'
const MAX_WIDTH = 1000
const RATIO = 0.5
const QUALITY = 0.92

export function SignaturePad({
  id,
  value,
  onChange,
  invalid,
  describedBy,
}: {
  id: string
  /** The signature as a JPEG data URL, or '' when there is none. */
  value: string
  onChange: (image: string) => void
  invalid?: boolean
  describedBy?: string
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const last = useRef<{ x: number; y: number } | null>(null)
  /** The image the canvas shows now; a different `value` from outside is a draft being restored or cleared. */
  const shown = useRef<string | null>(null)
  const valueRef = useRef(value)
  valueRef.current = value
  const [signed, setSigned] = useState(Boolean(value))

  /** Sizes the canvas to its box (sharp on a phone screen), makes it white and puts `image` on it. */
  const paint = useCallback((image: string) => {
    const canvas = canvasRef.current
    if (!canvas) return
    const box = canvas.getBoundingClientRect()
    if (box.width < 1) return
    const width = Math.min(MAX_WIDTH, Math.round(box.width * (window.devicePixelRatio || 1)))
    canvas.width = width
    canvas.height = Math.round(width * RATIO)
    const context = canvas.getContext('2d')
    if (!context) return
    context.fillStyle = '#ffffff'
    context.fillRect(0, 0, canvas.width, canvas.height)
    context.strokeStyle = INK
    context.lineCap = 'round'
    context.lineJoin = 'round'
    context.lineWidth = Math.max(2, (width / box.width) * 2.5)
    shown.current = image
    if (!image) return
    const picture = new Image()
    picture.onload = () => {
      if (shown.current === image) context.drawImage(picture, 0, 0, canvas.width, canvas.height)
    }
    picture.src = image
  }, [])

  useEffect(() => {
    paint(valueRef.current)
    const canvas = canvasRef.current
    if (!canvas || typeof ResizeObserver === 'undefined') return
    let width = canvas.getBoundingClientRect().width
    const observer = new ResizeObserver(() => {
      const next = canvas.getBoundingClientRect().width
      if (Math.abs(next - width) < 2) return
      width = next
      paint(valueRef.current)
    })
    observer.observe(canvas)
    return () => observer.disconnect()
  }, [paint])

  useEffect(() => {
    if (value !== shown.current) {
      paint(value)
      setSigned(Boolean(value))
    }
  }, [value, paint])

  function point(event: React.PointerEvent<HTMLCanvasElement>) {
    const canvas = event.currentTarget
    const box = canvas.getBoundingClientRect()
    return { x: ((event.clientX - box.left) * canvas.width) / box.width, y: ((event.clientY - box.top) * canvas.height) / box.height }
  }

  function start(event: React.PointerEvent<HTMLCanvasElement>) {
    if (event.button !== 0 && event.pointerType === 'mouse') return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    const from = point(event)
    last.current = from
    const context = event.currentTarget.getContext('2d')
    if (!context) return
    // A dot, so that a tap leaves a mark too.
    context.beginPath()
    context.moveTo(from.x, from.y)
    context.lineTo(from.x + 0.01, from.y)
    context.stroke()
  }

  function move(event: React.PointerEvent<HTMLCanvasElement>) {
    const from = last.current
    if (!from) return
    event.preventDefault()
    const to = point(event)
    const context = event.currentTarget.getContext('2d')
    if (!context) return
    context.beginPath()
    context.moveTo(from.x, from.y)
    context.lineTo(to.x, to.y)
    context.stroke()
    last.current = to
  }

  function end(event: React.PointerEvent<HTMLCanvasElement>) {
    if (!last.current) return
    last.current = null
    const image = event.currentTarget.toDataURL('image/jpeg', QUALITY)
    shown.current = image
    setSigned(true)
    onChange(image)
  }

  function clear() {
    paint('')
    setSigned(false)
    onChange('')
  }

  return (
    <div className="grid gap-2">
      <canvas
        ref={canvasRef}
        id={id}
        tabIndex={0}
        role="img"
        aria-label={signed ? 'Handtekening van de klant (getekend)' : 'Handtekening van de klant (nog leeg). Teken met je vinger.'}
        aria-describedby={describedBy}
        data-invalid={invalid ? 'true' : undefined}
        data-signed={signed ? 'true' : 'false'}
        className="block aspect-[2/1] max-h-72 w-full touch-none rounded-lg border-2 border-dashed border-input bg-white outline-none focus-visible:ring-[3px] focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background data-[invalid=true]:border-destructive"
        onPointerDown={start}
        onPointerMove={move}
        onPointerUp={end}
        onPointerCancel={end}
        onLostPointerCapture={end}
      />
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">{signed ? 'Getekend.' : 'Laat de klant hier met een vinger tekenen.'}</p>
        <Button type="button" variant="outline" className="h-11 px-4 text-base focus-visible:ring-[3px]" onClick={clear} disabled={!signed}>
          <Eraser className="size-4" /> Wissen
        </Button>
      </div>
    </div>
  )
}
