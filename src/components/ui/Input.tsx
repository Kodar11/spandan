import type { InputHTMLAttributes } from 'react'

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  /** Unit shown inside the field on the right (e.g. "ms"). */
  suffix?: string
  invalid?: boolean
}

export function Input({
  suffix,
  invalid = false,
  className = '',
  ...props
}: InputProps) {
  return (
    <div
      className={`flex h-9 items-center rounded-[var(--spandan-radius-sm)] border bg-white/[0.03] transition-colors focus-within:bg-white/[0.05] ${
        invalid
          ? 'border-rose-400/60'
          : 'border-[var(--spandan-border-strong)] hover:border-white/20 focus-within:border-cyan-400/60'
      } ${className}`}
    >
      <input
        aria-invalid={invalid || undefined}
        className="h-full w-full min-w-0 bg-transparent px-3 text-sm text-slate-100 placeholder-slate-500 outline-none"
        {...props}
      />
      {suffix && (
        <span className="pr-3 text-xs font-medium text-slate-500 select-none">
          {suffix}
        </span>
      )}
    </div>
  )
}
