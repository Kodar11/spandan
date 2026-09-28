import type {
  ExtensionMessage,
  ExtensionResponse,
  VideoStatus,
} from '@/types'

/**
 * Content script injected into every page matched by manifest.json.
 *
 * On YouTube pages it controls the HTML5 <video> element(s). It supports:
 * - Direct PLAY / PAUSE
 * - FADE_IN_PLAY / FADE_OUT_PAUSE with configurable durations
 * - Detection of user-initiated pause / play / mute events
 *
 * Using the existing <video> element(s) means playback resumes from the exact
 * timestamp where it was paused.
 */

const YOUTUBE_HOSTS = [
  'youtube.com',
  'music.youtube.com',
  'youtube-nocookie.com',
  'youtu.be',
]

function isYouTubePage(): boolean {
  return YOUTUBE_HOSTS.some((host) => window.location.hostname.includes(host))
}

function getVideoElements(): HTMLVideoElement[] {
  return Array.from(document.querySelectorAll('video'))
}

// Keep in sync with the injected copy in src/lib/video.ts.
function getVideoStatus(videos: HTMLVideoElement[]): VideoStatus {
  const playing = videos.filter((video) => !video.paused)
  const isPlaying = playing.length > 0
  // Muted means silenced by mute or zero volume, never merely paused. Judge the
  // playing video(s) when there are any, otherwise every video on the page.
  const relevant = isPlaying ? playing : videos
  const isMuted =
    relevant.length > 0 &&
    relevant.every((video) => video.muted || video.volume === 0)
  return { isPlaying, isMuted }
}

// Flags used to distinguish extension-initiated media changes from user
// actions, so the extension never fights the user.
let extensionPaused = false
let extensionPlayed = false
let extensionFading = false

// Stores each video's volume before a fade-out, so fade-in can restore it.
const originalVolumes = new Map<HTMLVideoElement, number>()

let userStateDebounceTimer: ReturnType<typeof setTimeout> | null = null
const USER_STATE_DEBOUNCE_MS = 100

// Tracked per script instance rather than on the DOM, so a copy re-injected
// after an extension reload still attaches its own listeners.
const videosWithListeners = new WeakSet<HTMLVideoElement>()

function notifyBackground(message: ExtensionMessage): void {
  chrome.runtime.sendMessage(message).catch(() => {
    // The service worker may be temporarily unavailable.
  })
}

function debouncedNotifyUserState(): void {
  if (userStateDebounceTimer) {
    clearTimeout(userStateDebounceTimer)
  }

  userStateDebounceTimer = setTimeout(() => {
    userStateDebounceTimer = null

    // If an extension action started while we were debouncing, skip the
    // notification so we don't report extension-initiated state as user state.
    if (isExtensionInitiated()) {
      return
    }

    const videos = getVideoElements()
    const status = getVideoStatus(videos)
    notifyBackground({ type: 'USER_STATE_CHANGED', payload: status })
  }, USER_STATE_DEBOUNCE_MS)
}

function isExtensionInitiated(): boolean {
  return extensionPaused || extensionPlayed || extensionFading
}

function attachMediaListeners(video: HTMLVideoElement): void {
  if (videosWithListeners.has(video)) return
  videosWithListeners.add(video)

  const handleUserMediaEvent = (): void => {
    if (isExtensionInitiated()) return
    debouncedNotifyUserState()
  }

  video.addEventListener('pause', handleUserMediaEvent)
  video.addEventListener('play', handleUserMediaEvent)
  video.addEventListener('volumechange', handleUserMediaEvent)
}

function observeNewVideos(): void {
  const observer = new MutationObserver(() => {
    getVideoElements().forEach(attachMediaListeners)
  })
  observer.observe(document.body, { childList: true, subtree: true })
}

if (isYouTubePage()) {

  getVideoElements().forEach(attachMediaListeners)
  observeNewVideos()

  notifyBackground({ type: 'CONTENT_READY' })
}

// ---------------------------------------------------------------------------
// Volume fading
// ---------------------------------------------------------------------------

function fadeVolume(
  video: HTMLVideoElement,
  from: number,
  to: number,
  durationMs: number,
): Promise<void> {
  return new Promise((resolve) => {
    const start = performance.now()
    // Use setTimeout instead of requestAnimationFrame so the fade completes
    // even when the tab is in the background (rAF is paused/throttled).
    const STEP_MS = 16
    const MAX_DURATION_MS = durationMs * 1.5 + 500

    function step(): void {
      const elapsed = performance.now() - start
      const progress = Math.min(elapsed / durationMs, 1)
      video.volume = from + (to - from) * progress

      if (progress < 1 && elapsed < MAX_DURATION_MS) {
        setTimeout(step, STEP_MS)
      } else {
        if (progress >= 1) {
          video.volume = to
        }
        resolve()
      }
    }

    setTimeout(step, 0)
  })
}

async function fadeOutAndPause(
  videos: HTMLVideoElement[],
  durationMs: number,
): Promise<void> {
  extensionFading = true
  extensionPaused = true

  try {
    videos.forEach((video) => {
      originalVolumes.set(video, video.volume)
    })

    await Promise.all(
      videos.map((video) => fadeVolume(video, video.volume, 0, durationMs)),
    )

    videos.forEach((video) => video.pause())
  } finally {
    // Restore original volume so a manual resume isn't silent.
    videos.forEach((video) => {
      const target = originalVolumes.get(video)
      if (target !== undefined) {
        video.volume = target
      }
    })

    setTimeout(() => {
      extensionFading = false
      extensionPaused = false
    }, 100)
  }
}

async function fadeInAndPlay(
  videos: HTMLVideoElement[],
  durationMs: number,
): Promise<void> {
  extensionFading = true
  extensionPlayed = true

  try {
    videos.forEach((video) => {
      const target = originalVolumes.get(video) ?? video.volume
      originalVolumes.set(video, target)
      video.volume = 0
    })

    await Promise.all(videos.map((video) => video.play().catch(() => {})))

    await Promise.all(
      videos.map((video) => {
        const target = originalVolumes.get(video) ?? 1
        return fadeVolume(video, 0, target, durationMs)
      }),
    )
  } finally {
    setTimeout(() => {
      extensionFading = false
      extensionPlayed = false
    }, 100)
  }
}

// ---------------------------------------------------------------------------
// Message handler
// ---------------------------------------------------------------------------

/**
 * Report success only if the videos actually reached the requested state, so
 * the background never records a play/pause that did not happen (e.g. play()
 * rejected by autoplay policy).
 */
function respondWithOutcome(
  sendResponse: (response: ExtensionResponse) => void,
  videos: HTMLVideoElement[],
  expectPlaying: boolean,
): void {
  const status = getVideoStatus(videos)
  if (status.isPlaying === expectPlaying) {
    sendResponse({ ok: true, payload: status })
  } else {
    sendResponse({
      ok: false,
      payload: expectPlaying ? 'playback did not start' : 'video still playing',
    })
  }
}

chrome.runtime.onMessage.addListener(
  (
    message: ExtensionMessage,
    _sender,
    sendResponse: (response: ExtensionResponse) => void,
  ) => {


    if (!isYouTubePage()) {
      sendResponse({ ok: false, payload: 'not a YouTube page' })
      return true
    }

    const videos = getVideoElements()
    videos.forEach(attachMediaListeners)

    if (videos.length === 0) {
      sendResponse({ ok: false, payload: 'video element not ready' })
      return true
    }

    switch (message.type) {
      case 'PLAY': {
        extensionPlayed = true
        Promise.all(videos.map((video) => video.play().catch(() => {})))
          .then(() => respondWithOutcome(sendResponse, videos, true))
          .catch((error: unknown) =>
            sendResponse({ ok: false, payload: String(error) }),
          )
          .finally(() => {
            setTimeout(() => {
              extensionPlayed = false
            }, 50)
          })
        return true
      }

      case 'PAUSE': {
        extensionPaused = true
        videos.forEach((video) => video.pause())
        respondWithOutcome(sendResponse, videos, false)
        setTimeout(() => {
          extensionPaused = false
        }, 50)
        return true
      }

      case 'FADE_OUT_PAUSE': {
        const fadeOutDuration =
          (message.payload as { durationMs: number }).durationMs ?? 500

        fadeOutAndPause(videos, fadeOutDuration)
          .then(() => respondWithOutcome(sendResponse, videos, false))
          .catch((error: unknown) =>
            sendResponse({ ok: false, payload: String(error) }),
          )
        return true
      }

      case 'FADE_IN_PLAY': {
        const fadeInDuration =
          (message.payload as { durationMs: number }).durationMs ?? 500

        fadeInAndPlay(videos, fadeInDuration)
          .then(() => respondWithOutcome(sendResponse, videos, true))
          .catch((error: unknown) =>
            sendResponse({ ok: false, payload: String(error) }),
          )
        return true
      }

      case 'GET_VIDEO_STATUS': {
        const status = getVideoStatus(videos)
        sendResponse({ ok: true, payload: status })
        return true
      }

      default:
        sendResponse({ ok: false, payload: 'unknown message type' })
        return true
    }
  },
)
