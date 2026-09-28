import {
  DEFAULT_SETTINGS,
  getSettings,
  setSettings,
  getState,
  setState,
} from '@/lib/storage'
import {
  cancelResumeTimer,
  hasResumeTimer,
  scheduleResumeTimer,
} from '@/lib/timers'
import { getComputedStatus, getWhitelistedNonMusicTabs } from '@/lib/status'
import {
  findTabByUrl,
  getUrlKey,
  isMusicTab,
  isYouTubeUrl,
  queryAudibleTabs,
} from '@/lib/tabs'
import { queryVideoStatus } from '@/lib/video'
import type {
  ExtensionMessage,
  ExtensionResponse,
  ExtensionSettings,
  ExtensionState,
  MusicTab,
  VideoStatus,
} from '@/types'

/**
 * Background service worker for spandan.
 *
 * Responsibilities:
 * - Restore the saved music tab after browser restart.
 * - Listen for audible-tab changes and pause/resume the music tab.
 * - Respect user-initiated pause/mute and manual-pause state.
 * - Apply resume delays and fade durations from settings.
 * - Enforce the website whitelist.
 * - Report rich status to the popup.
 *
 * MV3 service workers are ephemeral, so nothing here relies on in-memory
 * timers for correctness. Tab events (audible/url/removed) drive evaluation;
 * a chrome.alarms backup re-evaluates periodically in case an event is missed;
 * the resume deadline is persisted so a fresh worker can honour it.
 */

const BACKUP_ALARM_NAME = 'spandan-backup-evaluation'
// Chrome's minimum alarm period (30s). Events provide fast response; this is
// only a liveness/reconciliation fallback.
const BACKUP_ALARM_PERIOD_MINUTES = 0.5

// chrome.storage.session is cleared on browser restart and extension reload,
// both of which can invalidate the saved tab ID.
const SESSION_STARTED_KEY = 'sessionStarted'

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

chrome.runtime.onInstalled.addListener(async () => {
  const existing = await getSettings()
  await setSettings({ ...DEFAULT_SETTINGS, ...existing })
})

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === BACKUP_ALARM_NAME) {
    evaluatePlayback().catch(() => {})
  }
})

// Runs every time the service worker starts (browser start, extension reload,
// or waking from idle). Covers what chrome.runtime.onStartup used to do.
initializeWorker().catch((error: unknown) => {
  console.warn('[spandan] worker initialization failed', error)
})

async function initializeWorker(): Promise<void> {
  const session = await chrome.storage.session.get(SESSION_STARTED_KEY)

  if (!session[SESSION_STARTED_KEY]) {
    await chrome.storage.session.set({ [SESSION_STARTED_KEY]: true })
    await restoreMusicTab()
  } else {
    // Worker woke from idle: tab IDs are still valid. Re-arm the backup alarm
    // and any pending resume timer lost with the previous worker.
    await evaluatePlayback()
  }
}

// ---------------------------------------------------------------------------
// Tab event listeners
// ---------------------------------------------------------------------------

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  const state = await getState()

  if (isMusicTab(tabId, state.musicTab)) {
    if (tab.url && !isYouTubeUrl(tab.url)) {
      await clearMusicTab()
      return
    }

    if (changeInfo.url && tab.url && state.musicTab) {
      await setState({
        musicTab: {
          tabId,
          url: tab.url,
          title: tab.title || state.musicTab.title,
        },
      })
    }
  }

  // Audible changes are the primary trigger for pause/resume. Navigation also
  // triggers an evaluation so SPA route changes are handled promptly.
  if (changeInfo.audible !== undefined || changeInfo.url) {
    await evaluatePlayback()
  }
})

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const state = await getState()

  if (isMusicTab(tabId, state.musicTab)) {
    await clearMusicTab()
  } else {
    await evaluatePlayback()
  }
})

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.settings) return

  const newSettings = changes.settings.newValue as ExtensionSettings
  const oldSettings = changes.settings.oldValue as ExtensionSettings | undefined

  if (!newSettings.enabled) {
    stopAllAutomation()
    // The resume timer was cancelled, so don't leave a stale deadline behind.
    setState({ waitingToResumeUntil: null }).catch(() => {})
    return
  }

  // If the resume delay changed while we were waiting to resume, restart the
  // timer with the new value so the user sees the updated delay immediately.
  if (
    oldSettings &&
    newSettings.resumeDelayMs !== oldSettings.resumeDelayMs
  ) {
    cancelResumeTimer()
    setState({ waitingToResumeUntil: null })
      .then(() => evaluatePlayback())
      .catch(() => {})
    return
  }

  evaluatePlayback().catch(() => {})
})

// ---------------------------------------------------------------------------
// Message router
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener(
  (
    message: ExtensionMessage,
    sender,
    sendResponse: (response: ExtensionResponse) => void,
  ) => {
    handleMessage(message, sender)
      .then(sendResponse)
      .catch((error: unknown) => {
        sendResponse({ ok: false, payload: String(error) })
      })

    return true
  },
)

async function handleMessage(
  message: ExtensionMessage,
  sender: chrome.runtime.MessageSender,
): Promise<ExtensionResponse> {
  switch (message.type) {
    case 'PING':
      return { ok: true, payload: 'pong' }

    case 'GET_STATUS':
      return handleGetStatus()

    case 'SET_MUSIC_TAB':
      return handleSetMusicTab(message.payload)

    case 'CONTENT_READY': {
      const state = await getState()
      if (sender.tab?.id && isMusicTab(sender.tab.id, state.musicTab)) {
        await evaluatePlayback()
      }
      return { ok: true }
    }

    case 'USER_PAUSED':
    case 'USER_MUTED':
    case 'USER_PLAYED':
    case 'USER_UNMUTED':
      // Legacy individual events are kept for compatibility but are now
      // superseded by USER_STATE_CHANGED, which is debounced and carries the
      // full aggregate state.
      return { ok: true }

    case 'USER_STATE_CHANGED':
      await handleUserStateChanged(sender.tab?.id, message.payload)
      return { ok: true }

    default:
      return { ok: false, payload: 'unknown message type' }
  }
}

async function handleGetStatus(): Promise<ExtensionResponse> {
  const [settings, state] = await Promise.all([getSettings(), getState()])
  const status = await getComputedStatus(settings, state)
  return { ok: true, payload: status }
}

async function handleSetMusicTab(
  musicTab: MusicTab,
): Promise<ExtensionResponse> {
  if (!isYouTubeUrl(musicTab.url)) {
    return {
      ok: false,
      payload: 'Only YouTube tabs can be set as the music tab.',
    }
  }

  // Query the actual video state so we don't trigger an unwanted fade-in
  // when the user selects a tab that is already playing. A paused video is
  // not a manual pause; only a paused *and* muted one signals that intent.
  const videoStatus = await queryVideoStatus(musicTab.tabId)

  await setState({
    musicTab,
    isPlaying: videoStatus?.isPlaying ?? false,
    manuallyPaused: videoStatus
      ? !videoStatus.isPlaying && videoStatus.isMuted
      : false,
    waitingToResumeUntil: null,
  })
  await evaluatePlayback()

  return { ok: true, payload: musicTab }
}

async function handleUserStateChanged(
  tabId: number | undefined,
  status: VideoStatus,
): Promise<void> {
  if (!tabId) return
  const state = await getState()
  if (!isMusicTab(tabId, state.musicTab)) return

  // The content script only sends this for media events it did not cause
  // itself (extensionPaused / extensionPlayed / extensionFading), so this
  // reflects a user action.
  const userIsActivelyListening = status.isPlaying && !status.isMuted

  if (userIsActivelyListening) {
    // User resumed the music (play or unmute). Re-enable auto-management and
    // let evaluatePlayback decide whether to fade out again immediately.
    await setState({ manuallyPaused: false, isPlaying: true })
    await evaluatePlayback()
  } else {
    // User paused or muted the music. Suspend auto-management until they
    // explicitly resume.
    cancelResumeTimer()
    await setState({
      isPlaying: status.isPlaying,
      manuallyPaused: true,
      waitingToResumeUntil: null,
    })
  }
}

// ---------------------------------------------------------------------------
// Music tab management
// ---------------------------------------------------------------------------

async function clearMusicTab(): Promise<void> {
  stopAllAutomation()
  await setState({
    musicTab: null,
    isPlaying: false,
    manuallyPaused: false,
    waitingToResumeUntil: null,
  })
}

/**
 * Re-attach to the saved music tab after the tab ID may have become invalid
 * (browser restart resets IDs; extension reload keeps them).
 */
async function restoreMusicTab(): Promise<void> {
  const state = await getState()
  if (!state.musicTab) return

  const tab =
    (await getTabIfSameUrl(state.musicTab)) ??
    (await findTabByUrl(state.musicTab.url))

  if (tab?.id) {
    await setState({
      musicTab: {
        tabId: tab.id,
        url: tab.url || state.musicTab.url,
        title: tab.title || state.musicTab.title,
      },
    })
    await evaluatePlayback()
  } else {
    await clearMusicTab()
  }
}

async function getTabIfSameUrl(
  musicTab: MusicTab,
): Promise<chrome.tabs.Tab | undefined> {
  try {
    const tab = await chrome.tabs.get(musicTab.tabId)
    if (tab.url && getUrlKey(tab.url) === getUrlKey(musicTab.url)) {
      return tab
    }
  } catch {
    // Tab ID no longer exists.
  }
  return undefined
}

/**
 * Confirm the saved tab ID still refers to a YouTube tab. Clears the music tab
 * otherwise, so a stale ID can't make every command fail indefinitely.
 */
async function verifyMusicTab(musicTab: MusicTab): Promise<boolean> {
  try {
    const tab = await chrome.tabs.get(musicTab.tabId)
    if (!tab.url || isYouTubeUrl(tab.url)) return true
  } catch {
    // Tab was closed while we missed the onRemoved event.
  }
  await clearMusicTab()
  return false
}

function stopAllAutomation(): void {
  cancelResumeTimer()
  chrome.alarms.clear(BACKUP_ALARM_NAME).catch(() => {})
}

/**
 * Make sure the periodic backup alarm exists. Alarms persist across worker
 * restarts, so only create it when missing; recreating would keep pushing the
 * next firing back.
 */
async function ensureBackupAlarm(): Promise<void> {
  const existing = await chrome.alarms.get(BACKUP_ALARM_NAME)
  if (existing?.periodInMinutes === BACKUP_ALARM_PERIOD_MINUTES) return

  // Same name replaces any existing alarm, so this never creates duplicates.
  await chrome.alarms.create(BACKUP_ALARM_NAME, {
    delayInMinutes: BACKUP_ALARM_PERIOD_MINUTES,
    periodInMinutes: BACKUP_ALARM_PERIOD_MINUTES,
  })
}

// ---------------------------------------------------------------------------
// Play/pause orchestration
// ---------------------------------------------------------------------------

// Evaluations are serialized so two triggers (e.g. an audible event and the
// resume timer) can never send overlapping fades to the same video. Requests
// that arrive while one is queued share that queued run.
let evaluationChain: Promise<void> = Promise.resolve()
let queuedEvaluation: Promise<void> | null = null

function evaluatePlayback(): Promise<void> {
  if (queuedEvaluation) return queuedEvaluation

  const run = evaluationChain.then(() => {
    queuedEvaluation = null
    return evaluatePlaybackNow()
  })
  queuedEvaluation = run
  evaluationChain = run.catch((error: unknown) => {
    console.warn('[spandan] evaluatePlayback failed', error)
  })
  return run
}

// Must never call evaluatePlayback() and await it, or the queue deadlocks.
async function evaluatePlaybackNow(): Promise<void> {
  const [settings, storedState] = await Promise.all([getSettings(), getState()])
  let state = storedState

  if (!settings.enabled) {
    stopAllAutomation()
    return
  }

  if (!state.musicTab?.tabId) {
    stopAllAutomation()
    return
  }

  await ensureBackupAlarm()

  if (!(await verifyMusicTab(state.musicTab))) return

  const [audibleTabs, videoStatus] = await Promise.all([
    queryAudibleTabs(),
    queryVideoStatus(state.musicTab.tabId),
  ])

  // Reconcile the cached flag with the real video whenever it is readable.
  if (videoStatus && videoStatus.isPlaying !== state.isPlaying) {
    await setState({ isPlaying: videoStatus.isPlaying })
    state = { ...state, isPlaying: videoStatus.isPlaying }
  }

  const nonMusicAudibleTabs = getWhitelistedNonMusicTabs(
    audibleTabs,
    state.musicTab,
    settings.whitelist,
  )

  if (nonMusicAudibleTabs.length > 0) {
    await handleNonMusicPlaying(settings, state, videoStatus)
  } else {
    await handleSilence(settings, state, videoStatus)
  }
}

async function handleNonMusicPlaying(
  settings: ExtensionSettings,
  state: ExtensionState,
  videoStatus: VideoStatus | null,
): Promise<void> {
  if (!state.musicTab?.tabId) return

  // Cancel any pending resume and clear the waiting flag.
  cancelResumeTimer()
  if (state.waitingToResumeUntil) {
    await setState({ waitingToResumeUntil: null })
  }

  if (state.manuallyPaused) {
    // Music is paused by the user; don't fight them.
    return
  }

  // Trust the actual video element; fall back to the cached flag only when
  // the video can't be read.
  const mayBePlaying = videoStatus ? videoStatus.isPlaying : state.isPlaying
  if (!mayBePlaying) return

  const ok = await sendCommand(state.musicTab.tabId, 'FADE_OUT_PAUSE', {
    durationMs: settings.fadeDurationMs,
  })
  // On failure isPlaying stays true; the next event or backup alarm retries.
  if (ok) {
    await setState({ isPlaying: false })
  }
}

async function handleSilence(
  settings: ExtensionSettings,
  state: ExtensionState,
  videoStatus: VideoStatus | null,
): Promise<void> {
  if (!state.musicTab?.tabId) return

  if (state.manuallyPaused) {
    return
  }

  // Already playing (e.g. the user pressed play during the wait): nothing to
  // resume, and any pending wait is obsolete.
  if (videoStatus?.isPlaying) {
    cancelResumeTimer()
    if (state.waitingToResumeUntil) {
      await setState({ waitingToResumeUntil: null })
    }
    return
  }

  if (state.waitingToResumeUntil) {
    const remainingMs = state.waitingToResumeUntil - Date.now()
    if (remainingMs > 0) {
      // Re-arm the in-memory timer if a previous worker instance owned it.
      if (!hasResumeTimer()) {
        scheduleResumeTimer(() => {
          evaluatePlayback().catch(() => {})
        }, remainingMs)
      }
      return
    }

    // Deadline passed (timer fired, or it expired while the worker was
    // inactive): resume now. Clearing the deadline first means a failed
    // resume starts a fresh delay on the next event/alarm rather than
    // retrying in a tight loop.
    cancelResumeTimer()
    await setState({ waitingToResumeUntil: null })
    const ok = await sendCommand(state.musicTab.tabId, 'FADE_IN_PLAY', {
      durationMs: settings.fadeDurationMs,
    })
    if (ok) {
      await setState({ isPlaying: true })
    }
    return
  }

  // Start the resume delay. The persisted deadline is authoritative; the
  // in-memory timer just makes the resume happen on time.
  const resumeAt = Date.now() + settings.resumeDelayMs
  await setState({ waitingToResumeUntil: resumeAt })

  scheduleResumeTimer(() => {
    evaluatePlayback().catch(() => {})
  }, settings.resumeDelayMs)
}

// ---------------------------------------------------------------------------
// Messaging helpers
// ---------------------------------------------------------------------------

async function sendCommand(
  tabId: number,
  command: 'PLAY' | 'PAUSE' | 'FADE_IN_PLAY' | 'FADE_OUT_PAUSE' | 'GET_VIDEO_STATUS',
  payload?: unknown,
): Promise<boolean> {
  const message = payload === undefined
    ? { type: command }
    : { type: command, payload }

  try {
    const response = (await chrome.tabs.sendMessage(tabId, message)) as ExtensionResponse

    if (response?.ok) {
      return true
    }

    console.warn(`[spandan] ${command} rejected on tab ${tabId}:`, response?.payload)
  } catch (error) {
    console.warn(`[spandan] sendCommand ERROR ${command} -> tab ${tabId}:`, error)

    // After an extension reload, the tab's old content script is orphaned and
    // nothing is listening. Re-inject so the retry below can succeed.
    if (isMissingReceiverError(error)) {
      await injectContentScript(tabId)
    }
  }

  await delay(500)

  try {
    const retryResponse = (await chrome.tabs.sendMessage(tabId, message)) as ExtensionResponse

    if (retryResponse?.ok) {
      return true
    }

    console.warn(`[spandan] ${command} retry rejected on tab ${tabId}:`, retryResponse?.payload)
  } catch (retryError) {
    console.warn(`[spandan] ${command} retry failed on tab ${tabId}`, retryError)
  }

  return false
}

function isMissingReceiverError(error: unknown): boolean {
  return String(error).includes('Receiving end does not exist')
}

async function injectContentScript(tabId: number): Promise<void> {
  const file = chrome.runtime.getManifest().content_scripts?.[0]?.js?.[0]
  if (!file) return

  try {
    const tab = await chrome.tabs.get(tabId)
    // A loading tab will get the manifest content script on its own;
    // injecting now could run it twice.
    if (tab.status !== 'complete' || !isYouTubeUrl(tab.url)) return

    await chrome.scripting.executeScript({ target: { tabId }, files: [file] })
  } catch (error) {
    console.warn(`[spandan] content script injection failed on tab ${tabId}`, error)
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
