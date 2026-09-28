import type { ReactNode } from 'react'

interface CardProps {
  children: ReactNode
  className?: string
}

export function Card({ children, className = '' }: CardProps) {
  return (
    <div
      className={`spandan-surface rounded-[var(--spandan-radius-md)] transition-colors duration-200 ${className}`}
    >
      {children}
    </div>
  )
}
