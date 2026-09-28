import { useId } from 'react'

interface ToggleProps {
  checked: boolean
  onChange: (checked: boolean) => void
  label: string
  description?: string
  className?: string
}

/** Switch with its label; the whole row is clickable. */
export function Toggle({
  checked,
  onChange,
  label,
  description,
  className = '',
}: ToggleProps) {
  const labelId = useId()
  const descriptionId = useId()

  return (
    <div
      className={`group flex cursor-pointer items-center justify-between gap-4 ${className}`}
      onClick={() => onChange(!checked)}
    >
      <div className="min-w-0">
        <p id={labelId} className="text-sm font-medium text-slate-100">
          {label}
        </p>
        {description && (
          <p id={descriptionId} className="text-xs leading-snug text-slate-500">
            {description}
          </p>
        )}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-labelledby={labelId}
        aria-describedby={description ? descriptionId : undefined}
        onClick={(event) => {
          // The row handles the click; don't toggle twice.
          event.stopPropagation()
          onChange(!checked)
        }}
        className={`relative inline-flex h-6 w-10 shrink-0 items-center rounded-full transition-colors duration-200 spandan-focus ${
          checked
            ? 'bg-cyan-500'
            : 'bg-slate-700 group-hover:bg-slate-600'
        }`}
      >
        <span
          className={`inline-block h-[18px] w-[18px] rounded-full bg-white shadow-sm transition-transform duration-200 ${
            checked ? 'translate-x-[19px]' : 'translate-x-[3px]'
          }`}
        />
      </button>
    </div>
  )
}
