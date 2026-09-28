import { StrictMode, Suspense } from 'react'
import { createRoot } from 'react-dom/client'
import '../src/index.css'
import Popup from './Popup'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Suspense
      fallback={
        <div className="h-[360px] w-[356px] bg-[var(--spandan-bg)]" />
      }
    >
      <Popup />
    </Suspense>
  </StrictMode>,
)
