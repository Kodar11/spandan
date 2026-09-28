import type { ButtonHTMLAttributes, ReactNode } from 'react'

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  children: ReactNode
  variant?: 'primary' | 'secondary' | 'ghost'
  size?: 'sm' | 'md'
}

export function Button({
  children,
  variant = 'primary',
  size = 'md',
  className = '',
  ...props
}: ButtonProps) {
  const base =
    'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-[var(--spandan-radius-sm)] font-semibold transition-[background-color,border-color,color,filter,transform,opacity] duration-150 spandan-focus disabled:cursor-not-allowed disabled:opacity-45 enabled:active:translate-y-px'

  const sizes = {
    sm: 'h-8 px-3 text-xs',
    md: 'h-10 px-4 text-sm',
  }

  const styles = {
    primary:
      'bg-gradient-to-r from-cyan-600 to-indigo-600 text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.14)] enabled:hover:brightness-110',
    secondary:
      'border border-[var(--spandan-border-strong)] bg-white/[0.03] text-slate-200 enabled:hover:border-white/20 enabled:hover:bg-white/[0.06] enabled:hover:text-white',
    ghost:
      'bg-transparent text-slate-400 enabled:hover:bg-white/[0.04] enabled:hover:text-slate-200',
  }

  return (
    <button
      type="button"
      className={`${base} ${sizes[size]} ${styles[variant]} ${className}`}
      {...props}
    >
      {children}
    </button>
  )
}
