import { useCallback, useEffect, useState } from 'react'
import type { LucideIcon } from 'lucide-react'
import {
  AlertTriangle,
  ArrowRight,
  AudioLines,
  Hand,
  Info,
  Music2,
  Pause,
  Power,
  Settings,
  Timer,
} from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { Logo } from '@/components/ui/Logo'
import { Toggle } from '@/components/ui/Toggle'
import { getComputedStatus } from '@/lib/status'
import {
  DEFAULT_SETTINGS,
  DEFAULT_STATE,
  getSettings,
  getState,
  setSettings,
} from '@/lib/storage'
import { cleanTabTitle, getHostname, isYouTubeUrl } from '@/lib/tabs'
import type {
  ExtensionResponse,
  ExtensionSettings,
  MusicTab,
  PlaybackStatus,
  StatusPayload,
} from '@/types'

interface UiState {
  settings: ExtensionSettings
  status: PlaybackStatus
  reason: string
  musicTab: MusicTab | null
  waitingSeconds: number | null
  /** A real failure (worker unreachable). Replaces the status card. */
  error: string | null
  /** Guidance after an action the user can fix (e.g. not a YouTube tab). */
  notice: string | null
}

const WORKER_TIMEOUT_MS = 2000
const WORKER_ERROR = 'Reload the extension, then try again.'
const NOT_YOUTUBE_NOTICE = 'Open a YouTube video in this tab, then try again.'

function sendMessageWithTimeout<T>(
  message: unknown,
  timeoutMs = WORKER_TIMEOUT_MS,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('Extension worker did not respond in time'))
    }, timeoutMs)

    chrome.runtime
      .sendMessage(message)
      .then((response) => {
        clearTimeout(timer)
        resolve(response as T)
      })
      .catch((error: unknown) => {
        clearTimeout(timer)
        reject(error)
      })
  })
}

async function loadInitialStatus(): Promise<UiState> {
  try {
    const [settings, state] = await Promise.all([getSettings(), getState()])
    const status = await getComputedStatus(settings, state)

    return {
      settings,
      status: status.status,
      reason: status.reason,
      musicTab: status.musicTab,
      waitingSeconds: status.waitingSeconds,
      error: null,
      notice: null,
    }
  } catch (error) {
    console.error('[spandan] popup failed to load status', error)

    const [settings, state] = await Promise.all([
      getSettings().catch(() => DEFAULT_SETTINGS),
      getState().catch(() => DEFAULT_STATE),
    ])

    return {
      settings,
      status: 'no_music_tab',
      reason: '',
      musicTab: state.musicTab,
      waitingSeconds: null,
      error: WORKER_ERROR,
      notice: null,
    }
  }
}

// ---------------------------------------------------------------------------
// Status presentation
// ---------------------------------------------------------------------------

interface StatusLook {
  title: string
  icon: LucideIcon
  /** Icon tile colours. */
  tile: string
}

const STATUS_LOOK: Record<PlaybackStatus | 'error', StatusLook> = {
  playing: {
    title: 'Music playing',
    icon: AudioLines,
    tile: 'bg-emerald-400/10 text-emerald-300 ring-emerald-300/15',
  },
  paused: {
    title: 'Music paused',
    icon: Pause,
    tile: 'bg-cyan-400/10 text-cyan-300 ring-cyan-300/15',
  },
  waiting: {
    title: 'Waiting to resume',
    icon: Timer,
    tile: 'bg-amber-400/10 text-amber-300 ring-amber-300/15',
  },
  manual_pause: {
    title: 'Paused by you',
    icon: Hand,
    tile: 'bg-white/[0.06] text-slate-200 ring-white/10',
  },
  disabled: {
    title: 'Spandan is off',
    icon: Power,
    tile: 'bg-white/[0.04] text-slate-500 ring-white/[0.06]',
  },
  no_music_tab: {
    title: 'No music tab selected',
    icon: Music2,
    tile: 'bg-white/[0.04] text-slate-400 ring-white/[0.06]',
  },
  error: {
    title: 'Something went wrong',
    icon: AlertTriangle,
    tile: 'bg-rose-400/10 text-rose-300 ring-rose-300/15',
  },
}

function waitingReason(seconds: number): string {
  return `Resuming in ${seconds} ${seconds === 1 ? 'second' : 'seconds'}.`
}

// ---------------------------------------------------------------------------
// Popup
// ---------------------------------------------------------------------------

export default function Popup() {
  const [uiState, setUiState] = useState<UiState | null>(null)
  const [activeTabIsYouTube, setActiveTabIsYouTube] = useState(true)
  const [settingTab, setSettingTab] = useState(false)

  const refreshStatus = useCallback(async () => {
    try {
      const response = await sendMessageWithTimeout<ExtensionResponse>({
        type: 'GET_STATUS',
      })

      if (response.ok && response.payload) {
        const payload = response.payload as StatusPayload
        setUiState((current) =>
          current
            ? {
                ...current,
                status: payload.status,
                reason: payload.reason,
                musicTab: payload.musicTab,
                waitingSeconds: payload.waitingSeconds,
                settings: { ...current.settings, enabled: payload.enabled },
                error: null,
              }
            : current,
        )
      }
    } catch (err) {
      console.error('[spandan] popup refresh failed', err)
      setUiState((current) =>
        current ? { ...current, error: WORKER_ERROR } : current,
      )
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    loadInitialStatus().then((state) => {
      if (!cancelled) setUiState(state)
    })
    chrome.tabs
      .query({ active: true, currentWindow: true })
      .then(([tab]) => {
        if (!cancelled) setActiveTabIsYouTube(isYouTubeUrl(tab?.url))
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  // Keep the status live while the popup is open: the worker persists every
  // pause/resume/wait, so storage changes are the signal to refresh.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const onChanged = (
      changes: Record<string, chrome.storage.StorageChange>,
      area: string,
    ) => {
      if (area !== 'local' || (!changes.state && !changes.settings)) return
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => void refreshStatus(), 120)
    }
    chrome.storage.onChanged.addListener(onChanged)
    return () => {
      if (timer) clearTimeout(timer)
      chrome.storage.onChanged.removeListener(onChanged)
    }
  }, [refreshStatus])

  useEffect(() => {
    if (uiState?.status !== 'waiting' || uiState.waitingSeconds === null)
      return

    const interval = setInterval(() => {
      setUiState((current) => {
        if (
          !current ||
          current.waitingSeconds === null ||
          current.waitingSeconds <= 1
        ) {
          clearInterval(interval)
          void refreshStatus()
          return current
        }
        return {
          ...current,
          waitingSeconds: current.waitingSeconds - 1,
        }
      })
    }, 1000)

    return () => clearInterval(interval)
  }, [uiState?.status, uiState?.waitingSeconds, refreshStatus])

  const handleToggle = async (next: boolean) => {
    setUiState((current) =>
      current
        ? {
            ...current,
            settings: { ...current.settings, enabled: next },
            error: null,
          }
        : current,
    )
    await setSettings({ enabled: next })
    await refreshStatus()
  }

  const handleSetMusicTab = async () => {
    setUiState((current) =>
      current ? { ...current, error: null, notice: null } : current,
    )
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })

    if (!tab?.id || !tab.url) {
      setUiState((current) =>
        current
          ? { ...current, notice: 'Couldn’t read the current tab. Try again.' }
          : current,
      )
      return
    }

    if (!isYouTubeUrl(tab.url)) {
      setUiState((current) =>
        current ? { ...current, notice: NOT_YOUTUBE_NOTICE } : current,
      )
      return
    }

    setSettingTab(true)
    try {
      const response = await sendMessageWithTimeout<ExtensionResponse>({
        type: 'SET_MUSIC_TAB',
        payload: {
          tabId: tab.id,
          url: tab.url,
          title: tab.title || tab.url,
        },
      })

      if (!response.ok) {
        setUiState((current) =>
          current
            ? {
                ...current,
                notice: String(response.payload ?? 'Couldn’t set the music tab.'),
              }
            : current,
        )
      } else {
        await refreshStatus()
      }
    } catch (err) {
      console.error('[spandan] set music tab failed', err)
      setUiState((current) =>
        current ? { ...current, error: WORKER_ERROR } : current,
      )
    } finally {
      setSettingTab(false)
    }
  }

  if (!uiState) {
    return (
      <div className="flex h-[360px] w-[356px] items-center justify-center bg-[var(--spandan-bg)]">
        <Logo size={36} tile className="animate-pulse-soft" />
      </div>
    )
  }

  const isOnboarding = !uiState.musicTab

  const primaryAction = (
    <Button
      className="w-full"
      onClick={handleSetMusicTab}
      disabled={settingTab}
    >
      <Music2 size={16} strokeWidth={2.25} aria-hidden="true" />
      Set Current Tab as Music Tab
    </Button>
  )

  return (
    <div className="flex w-[356px] flex-col gap-3 bg-[var(--spandan-bg)] p-4 text-slate-100">
      <header className="flex items-center gap-3 pb-1">
        <Logo size={32} tile />
        <div className="min-w-0">
          <h1 className="text-[15px] leading-tight font-semibold tracking-tight">
            Spandan
          </h1>
          <p className="text-[11.5px] leading-tight text-slate-500">
            Adaptive music for deep focus
          </p>
        </div>
      </header>

      {isOnboarding ? (
        <Onboarding
          error={uiState.error}
          action={primaryAction}
          notice={uiState.notice}
          activeTabIsYouTube={activeTabIsYouTube}
        />
      ) : (
        <>
          <StatusCard uiState={uiState} />

          <Card
            className={`px-4 py-3 ${
              uiState.settings.enabled ? '' : 'bg-transparent'
            }`}
          >
            <Toggle
              label="Enable Spandan"
              description="Automatically manage background music."
              checked={uiState.settings.enabled}
              onChange={handleToggle}
            />
          </Card>

          <div className="space-y-2">
            {primaryAction}
            {uiState.notice && <Notice text={uiState.notice} />}
          </div>
        </>
      )}

      {isOnboarding && !uiState.settings.enabled && (
        <Card className="bg-transparent px-4 py-3">
          <Toggle
            label="Enable Spandan"
            description="Automatic music control is off."
            checked={false}
            onChange={handleToggle}
          />
        </Card>
      )}

      <button
        type="button"
        onClick={() => chrome.runtime.openOptionsPage()}
        className="spandan-focus mx-auto flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-slate-500 transition-colors duration-150 hover:text-slate-200"
      >
        <Settings size={13} aria-hidden="true" />
        Open Settings
      </button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

function StatusCard({ uiState }: { uiState: UiState }) {
  const key = uiState.error ? 'error' : uiState.status
  const look = STATUS_LOOK[key]
  const Icon = look.icon
  const reason = uiState.error
    ? uiState.error
    : uiState.status === 'waiting' && uiState.waitingSeconds !== null
      ? waitingReason(uiState.waitingSeconds)
      : uiState.reason

  const isWaiting = !uiState.error && uiState.status === 'waiting'
  const totalSeconds = Math.max(1, uiState.settings.resumeDelayMs / 1000)
  const progress = isWaiting
    ? Math.min(1, (uiState.waitingSeconds ?? 0) / totalSeconds)
    : 0

  return (
    <Card className="overflow-hidden">
      <div
        key={key}
        role="status"
        aria-live="polite"
        className="flex animate-fade-in items-center gap-3 px-4 pt-4 pb-3.5"
      >
        <span
          className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] ring-1 ring-inset transition-colors duration-200 ${look.tile}`}
        >
          <Icon size={18} strokeWidth={2} aria-hidden="true" />
        </span>
        <div className="min-w-0">
          <p className="text-[15px] leading-snug font-semibold text-slate-50">
            {look.title}
          </p>
          <p
            className={`truncate text-xs leading-snug ${
              uiState.error ? 'text-rose-200/80' : 'text-slate-400'
            }`}
            title={reason}
          >
            {reason}
          </p>
        </div>
      </div>

      {/* Divider doubles as the resume countdown. */}
      <div className="relative h-px bg-[var(--spandan-border)]">
        <div
          className="absolute inset-y-0 left-0 bg-amber-400/80 transition-[width,opacity] duration-1000 ease-linear"
          style={{ width: `${progress * 100}%`, opacity: isWaiting ? 1 : 0 }}
        />
      </div>

      {uiState.musicTab && (
        <MusicTabRow
          musicTab={uiState.musicTab}
          dimmed={!uiState.settings.enabled}
        />
      )}
    </Card>
  )
}

function MusicTabRow({
  musicTab,
  dimmed,
}: {
  musicTab: MusicTab
  dimmed: boolean
}) {
  const title = cleanTabTitle(musicTab.title)
  const host = getHostname(musicTab.url)?.replace(/^www\./, '') ?? 'youtube.com'

  return (
    <div
      className={`flex items-center gap-3 px-4 py-3 transition-opacity duration-200 ${
        dimmed ? 'opacity-55' : ''
      }`}
    >
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] bg-white/[0.04] text-slate-400">
        <Music2 size={15} aria-hidden="true" />
      </span>
      <div className="min-w-0">
        <p className="text-[10.5px] leading-tight font-medium tracking-wide text-slate-500 uppercase">
          Music tab
        </p>
        <p
          className="truncate text-[13px] leading-snug font-medium text-slate-200"
          title={title}
        >
          {title}
        </p>
        <p className="truncate text-[11px] leading-tight text-slate-500">{host}</p>
      </div>
    </div>
  )
}

function Onboarding({
  action,
  error,
  notice,
  activeTabIsYouTube,
}: {
  action: React.ReactNode
  error: string | null
  notice: string | null
  activeTabIsYouTube: boolean
}) {
  return (
    <>
      <Card className="flex animate-fade-in flex-col items-center px-5 pt-6 pb-5 text-center">
        <Logo size={44} tile />
        <h2 className="mt-4 text-[15px] font-semibold text-slate-50">
          Choose your music tab
        </h2>
        <p className="mt-1 max-w-[240px] text-xs leading-relaxed text-slate-400">
          Pick a YouTube tab for Spandan to manage in the background.
        </p>

        <div
          aria-label="How Spandan works: choose music, browse, music resumes automatically"
          role="img"
          className="mt-4 flex items-center gap-1.5 text-[11px] font-medium text-slate-400"
        >
          <Step>Choose music</Step>
          <ArrowRight size={11} className="text-slate-600" aria-hidden="true" />
          <Step>Browse</Step>
          <ArrowRight size={11} className="text-slate-600" aria-hidden="true" />
          <Step>Auto-resume</Step>
        </div>
      </Card>

      <div className="space-y-2">
        {action}
        {error ? (
          <Notice text={error} tone="error" />
        ) : notice ? (
          <Notice text={notice} />
        ) : (
          <p className="px-2 text-center text-[11.5px] leading-snug text-slate-500">
            {activeTabIsYouTube
              ? 'Spandan pauses it when another tab plays audio.'
              : 'Open a YouTube video in this tab to get started.'}
          </p>
        )}
      </div>
    </>
  )
}

function Step({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded-full bg-white/[0.04] px-2 py-0.5 ring-1 ring-inset ring-white/[0.06]">
      {children}
    </span>
  )
}

function Notice({
  text,
  tone = 'info',
}: {
  text: string
  tone?: 'info' | 'error'
}) {
  const Icon = tone === 'error' ? AlertTriangle : Info
  return (
    <p
      role={tone === 'error' ? 'alert' : 'status'}
      className={`flex animate-fade-in items-start justify-center gap-1.5 px-2 text-center text-[11.5px] leading-snug ${
        tone === 'error' ? 'text-rose-300' : 'text-amber-200/90'
      }`}
    >
      <Icon size={13} className="mt-px shrink-0" aria-hidden="true" />
      {text}
    </p>
  )
}
