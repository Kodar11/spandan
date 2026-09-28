import { useEffect, useId, useRef, useState } from 'react'
import type { KeyboardEvent, ReactNode } from 'react'
import { Check, Globe, Plus, RotateCcw, X } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { Input } from '@/components/ui/Input'
import { Logo } from '@/components/ui/Logo'
import { Toggle } from '@/components/ui/Toggle'
import { DEFAULT_SETTINGS, getSettings, setSettings } from '@/lib/storage'
import { normalizeWhitelistEntry } from '@/lib/tabs'
import type { ExtensionSettings } from '@/types'

const MIN_RESUME_DELAY_MS = 2000
const MAX_RESUME_DELAY_MS = 10000
const MIN_FADE_DURATION_MS = 0
const MAX_FADE_DURATION_MS = 2000

/** Form values; numbers stay as text so fields can be edited freely. */
interface Draft {
  enabled: boolean
  resumeDelayMs: string
  fadeDurationMs: string
  whitelist: string[]
}

type NumberField = 'resumeDelayMs' | 'fadeDurationMs'

function toDraft(settings: ExtensionSettings): Draft {
  return {
    enabled: settings.enabled,
    resumeDelayMs: String(settings.resumeDelayMs),
    fadeDurationMs: String(settings.fadeDurationMs),
    whitelist: settings.whitelist.filter(Boolean),
  }
}

function isSameDraft(a: Draft, b: Draft): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

function validateNumber(text: string, min: number, max: number): string | null {
  if (!/^\d+$/.test(text.trim())) return 'Enter a whole number of milliseconds.'
  const value = Number(text)
  if (value < min || value > max) {
    return `Use a value between ${min.toLocaleString()} and ${max.toLocaleString()} ms.`
  }
  return null
}

function validateDraft(draft: Draft): Partial<Record<NumberField, string>> {
  const errors: Partial<Record<NumberField, string>> = {}
  const resume = validateNumber(
    draft.resumeDelayMs,
    MIN_RESUME_DELAY_MS,
    MAX_RESUME_DELAY_MS,
  )
  const fade = validateNumber(
    draft.fadeDurationMs,
    MIN_FADE_DURATION_MS,
    MAX_FADE_DURATION_MS,
  )
  if (resume) errors.resumeDelayMs = resume
  if (fade) errors.fadeDurationMs = fade
  return errors
}

/**
 * Normalize user input to the hostname form the matcher already uses
 * (normalizeWhitelistEntry), accepting "udemy.com", "www.udemy.com/course" or
 * a full URL. Returns null if it isn't a plausible website.
 */
function parseWebsite(input: string): string | null {
  const trimmed = input.trim()
  if (!trimmed) return null
  const withProtocol = /^[a-z][a-z\d+.-]*:\/\//i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`
  const host = normalizeWhitelistEntry(withProtocol)
  const looksValid =
    host === 'localhost' || /^[a-z\d-]+(\.[a-z\d-]+)*\.[a-z]{2,}$/.test(host)
  return looksValid ? host : null
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function Options() {
  const [saved, setSaved] = useState<Draft | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [touched, setTouched] = useState<Partial<Record<NumberField, boolean>>>({})
  const [justSaved, setJustSaved] = useState(false)
  const savedRef = useRef<Draft | null>(null)

  useEffect(() => {
    savedRef.current = saved
  }, [saved])

  useEffect(() => {
    getSettings().then((settings) => {
      const initial = toDraft(settings)
      setSaved(initial)
      setDraft(initial)
    })
  }, [])

  // Pick up changes made elsewhere (e.g. the popup toggle) unless the user is
  // in the middle of editing.
  useEffect(() => {
    const onChanged = (
      changes: Record<string, chrome.storage.StorageChange>,
      area: string,
    ) => {
      if (area !== 'local' || !changes.settings?.newValue) return
      const next = toDraft({
        ...DEFAULT_SETTINGS,
        ...(changes.settings.newValue as ExtensionSettings),
      })
      const previousSaved = savedRef.current
      setSaved(next)
      setDraft((currentDraft) =>
        !currentDraft || (previousSaved && isSameDraft(currentDraft, previousSaved))
          ? next
          : currentDraft,
      )
    }
    chrome.storage.onChanged.addListener(onChanged)
    return () => chrome.storage.onChanged.removeListener(onChanged)
  }, [])

  useEffect(() => {
    if (!justSaved) return
    const timer = setTimeout(() => setJustSaved(false), 2200)
    return () => clearTimeout(timer)
  }, [justSaved])

  if (!draft || !saved) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[var(--spandan-bg)]">
        <Logo size={40} tile className="animate-pulse-soft" />
      </div>
    )
  }

  const errors = validateDraft(draft)
  const isDirty = !isSameDraft(draft, saved)
  const hasErrors = Object.keys(errors).length > 0

  const update = (partial: Partial<Draft>) => {
    setDraft({ ...draft, ...partial })
    setJustSaved(false)
  }

  const handleSave = async () => {
    if (hasErrors) {
      setTouched({ resumeDelayMs: true, fadeDurationMs: true })
      return
    }
    const next: ExtensionSettings = {
      enabled: draft.enabled,
      resumeDelayMs: Number(draft.resumeDelayMs),
      fadeDurationMs: Number(draft.fadeDurationMs),
      whitelist: draft.whitelist,
    }
    await setSettings(next)
    const normalized = toDraft(next)
    setSaved(normalized)
    setDraft(normalized)
    setTouched({})
    setJustSaved(true)
  }

  const handleReset = async () => {
    if (!confirm('Reset all settings to their defaults?')) return
    await setSettings(DEFAULT_SETTINGS)
    const defaults = toDraft(DEFAULT_SETTINGS)
    setSaved(defaults)
    setDraft(defaults)
    setTouched({})
    setJustSaved(true)
  }

  const fieldError = (field: NumberField) =>
    touched[field] ? errors[field] : undefined

  return (
    <div className="min-h-screen bg-[var(--spandan-bg)] text-slate-100">
      <div className="mx-auto max-w-[720px] animate-fade-in px-6 pt-12">
        <header className="mb-10 flex items-center gap-4">
          <Logo size={44} tile />
          <div>
            <h1 className="text-xl leading-tight font-semibold tracking-tight">
              Spandan
            </h1>
            <p className="text-sm text-slate-500">
              Adaptive background music for deep focus.
            </p>
          </div>
        </header>

        <div className="space-y-8">
          <Section title="General">
            <Card className="px-5 py-4">
              <Toggle
                label="Enable Spandan"
                description="Automatically manage background music."
                checked={draft.enabled}
                onChange={(checked) => update({ enabled: checked })}
              />
            </Card>
          </Section>

          <Section title="Playback">
            <Card className="divide-y divide-[var(--spandan-border)]">
              <NumberSetting
                label="Resume delay"
                description="How long to wait after other audio stops before bringing music back."
                value={draft.resumeDelayMs}
                min={MIN_RESUME_DELAY_MS}
                max={MAX_RESUME_DELAY_MS}
                step={100}
                error={fieldError('resumeDelayMs')}
                onChange={(value) => update({ resumeDelayMs: value })}
                onBlur={() => setTouched({ ...touched, resumeDelayMs: true })}
              />
              <NumberSetting
                label="Fade duration"
                description="How smoothly music fades out and back in. Use 0 for no fade."
                value={draft.fadeDurationMs}
                min={MIN_FADE_DURATION_MS}
                max={MAX_FADE_DURATION_MS}
                step={50}
                error={fieldError('fadeDurationMs')}
                onChange={(value) => update({ fadeDurationMs: value })}
                onBlur={() => setTouched({ ...touched, fadeDurationMs: true })}
              />
            </Card>
          </Section>

          <Section title="Detection">
            <Card className="px-5 py-5">
              <WhitelistEditor
                sites={draft.whitelist}
                onChange={(whitelist) => update({ whitelist })}
              />
            </Card>
          </Section>
        </div>
      </div>

      {/* Save bar */}
      <div className="sticky bottom-0 mt-10 border-t border-[var(--spandan-border)] bg-[var(--spandan-bg)]/90 backdrop-blur-md">
        <div className="mx-auto flex h-16 max-w-[720px] items-center justify-between gap-4 px-6">
          <SaveState dirty={isDirty} justSaved={justSaved} />
          <div className="flex items-center gap-2">
            <Button variant="ghost" onClick={handleReset}>
              <RotateCcw size={14} aria-hidden="true" />
              Reset to defaults
            </Button>
            <Button onClick={handleSave} disabled={!isDirty} className="min-w-[132px]">
              Save changes
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

function Section({ title, children }: { title: string; children: ReactNode }) {
  const id = useId()
  return (
    <section aria-labelledby={id}>
      <h2
        id={id}
        className="mb-2.5 px-1 text-[11px] font-semibold tracking-[0.08em] text-slate-500 uppercase"
      >
        {title}
      </h2>
      {children}
    </section>
  )
}

function NumberSetting({
  label,
  description,
  value,
  min,
  max,
  step,
  error,
  onChange,
  onBlur,
}: {
  label: string
  description: string
  value: string
  min: number
  max: number
  step: number
  error?: string
  onChange: (value: string) => void
  onBlur: () => void
}) {
  const inputId = useId()
  const descriptionId = useId()
  const errorId = useId()

  return (
    <div className="px-5 py-4">
      <div className="flex items-center justify-between gap-6">
        <div className="min-w-0">
          <label htmlFor={inputId} className="text-sm font-medium text-slate-100">
            {label}
          </label>
          <p id={descriptionId} className="text-xs leading-snug text-slate-500">
            {description}
          </p>
        </div>
        <Input
          id={inputId}
          type="number"
          inputMode="numeric"
          min={min}
          max={max}
          step={step}
          suffix="ms"
          value={value}
          invalid={Boolean(error)}
          aria-describedby={error ? `${descriptionId} ${errorId}` : descriptionId}
          onChange={(event) => onChange(event.target.value)}
          onBlur={onBlur}
          className="w-32 shrink-0"
        />
      </div>
      {error && (
        <p id={errorId} className="mt-2 animate-fade-in text-xs text-rose-300">
          {error}
        </p>
      )}
    </div>
  )
}

function WhitelistEditor({
  sites,
  onChange,
}: {
  sites: string[]
  onChange: (sites: string[]) => void
}) {
  const [input, setInput] = useState('')
  const [error, setError] = useState<string | null>(null)
  const inputId = useId()
  const descriptionId = useId()
  const errorId = useId()

  const add = () => {
    if (!input.trim()) return
    const host = parseWebsite(input)
    if (!host) {
      setError('Enter a website like udemy.com.')
      return
    }
    // Compare in normalized form so "https://www.udemy.com/" and "udemy.com"
    // count as the same site.
    if (sites.some((site) => normalizeWhitelistEntry(site) === host)) {
      setError(`${host} is already on the list.`)
      return
    }
    onChange([...sites, host])
    setInput('')
    setError(null)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      add()
    }
  }

  return (
    <div>
      <label htmlFor={inputId} className="text-sm font-medium text-slate-100">
        Website whitelist
      </label>
      <p id={descriptionId} className="text-xs leading-snug text-slate-500">
        Only these websites can pause your music. Subdomains are included.
      </p>

      <div className="mt-4 flex gap-2">
        <Input
          id={inputId}
          type="text"
          placeholder="udemy.com"
          autoComplete="off"
          spellCheck={false}
          value={input}
          invalid={Boolean(error)}
          aria-describedby={error ? `${descriptionId} ${errorId}` : descriptionId}
          onChange={(event) => {
            setInput(event.target.value)
            setError(null)
          }}
          onKeyDown={onKeyDown}
          className="flex-1"
        />
        <Button
          variant="secondary"
          onClick={add}
          disabled={!input.trim()}
          className="h-9"
        >
          <Plus size={15} aria-hidden="true" />
          Add website
        </Button>
      </div>
      {error && (
        <p id={errorId} role="alert" className="mt-2 animate-fade-in text-xs text-rose-300">
          {error}
        </p>
      )}

      {sites.length === 0 ? (
        <div className="mt-4 flex items-center gap-3 rounded-[var(--spandan-radius-sm)] border border-dashed border-[var(--spandan-border-strong)] px-4 py-3.5">
          <Globe size={16} className="shrink-0 text-slate-500" aria-hidden="true" />
          <div>
            <p className="text-[13px] font-medium text-slate-300">No websites added</p>
            <p className="text-xs text-slate-500">
              All audible websites can pause your music.
            </p>
          </div>
        </div>
      ) : (
        <>
          <ul
            aria-label="Whitelisted websites"
            className="mt-4 divide-y divide-[var(--spandan-border)] overflow-hidden rounded-[var(--spandan-radius-sm)] border border-[var(--spandan-border)]"
          >
            {sites.map((site) => (
              <li
                key={site}
                className="group flex h-11 animate-fade-in items-center gap-3 bg-white/[0.015] pr-1.5 pl-3.5 transition-colors hover:bg-white/[0.035]"
              >
                <Globe size={14} className="shrink-0 text-slate-500" aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate text-[13px] text-slate-200" title={site}>
                  {site}
                </span>
                <button
                  type="button"
                  onClick={() => onChange(sites.filter((s) => s !== site))}
                  aria-label={`Remove ${site}`}
                  className="spandan-focus flex h-8 w-8 items-center justify-center rounded-md text-slate-500 transition-colors hover:bg-white/[0.06] hover:text-slate-200"
                >
                  <X size={14} aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
          <p className="mt-2.5 px-0.5 text-xs text-slate-500">
            Remove every website to let all sites pause your music.
          </p>
        </>
      )}
    </div>
  )
}

function SaveState({ dirty, justSaved }: { dirty: boolean; justSaved: boolean }) {
  return (
    <p role="status" aria-live="polite" className="flex items-center gap-2 text-xs">
      {dirty ? (
        <span key="dirty" className="flex animate-fade-in items-center gap-2 text-slate-300">
          <span className="h-1.5 w-1.5 rounded-full bg-amber-400" aria-hidden="true" />
          Unsaved changes
        </span>
      ) : justSaved ? (
        <span key="saved" className="flex animate-fade-in items-center gap-1.5 text-emerald-300">
          <Check size={14} aria-hidden="true" />
          Saved
        </span>
      ) : (
        <span key="clean" className="text-slate-600">
          All changes saved
        </span>
      )}
    </p>
  )
}
