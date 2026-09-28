interface LogoProps {
  /** Size of the square tile in px. */
  size?: number
  /** Render the icon on a subtle tile so it sits naturally on dark surfaces. */
  tile?: boolean
  className?: string
}

// The same artwork as the toolbar icon. Root-relative so it resolves from any
// extension page (chrome-extension://<id>/icon_128.png).
const ICON_SRC = '/icon_128.png'

export function Logo({ size = 32, tile = false, className = '' }: LogoProps) {
  const image = (
    <img
      src={ICON_SRC}
      width={size}
      height={size}
      alt=""
      aria-hidden="true"
      draggable={false}
      className={tile ? undefined : className}
    />
  )

  if (!tile) return image

  return (
    <span
      className={`inline-flex shrink-0 items-center justify-center overflow-hidden rounded-[28%] bg-cyan-400/[0.08] ring-1 ring-inset ring-cyan-300/15 ${className}`}
      style={{ width: size, height: size }}
    >
      {image}
    </span>
  )
}
