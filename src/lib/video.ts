import type { ExtensionResponse, VideoStatus } from '@/types'

/**
 * Query the actual playback state of the video element(s) in a tab.
 *
 * Uses chrome.scripting.executeScript as the primary mechanism because it works
 * even when the content script has not finished injecting yet. Falls back to
 * the content script message channel if executeScript is unavailable.
 *
 * Returns null when the state cannot be read (tab gone, page still loading, no
 * video element yet). Callers must treat that as "unknown" rather than paused.
 */
export async function queryVideoStatus(
  tabId: number,
): Promise<VideoStatus | null> {
  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId },
      // Must be self-contained; mirrors getVideoStatus in src/content/index.ts.
      func: () => {
        const videos = Array.from(document.querySelectorAll('video'))
        if (videos.length === 0) return null
        const playing = videos.filter((video) => !video.paused)
        const isPlaying = playing.length > 0
        const relevant = isPlaying ? playing : videos
        const isMuted = relevant.every(
          (video) => video.muted || video.volume === 0,
        )
        return { isPlaying, isMuted }
      },
    })

    const status = result?.result as VideoStatus | null | undefined
    if (status) {
      return status
    }
  } catch (error) {
    console.warn(
      '[spandan] executeScript failed, falling back to message',
      error,
    )
  }

  // Fall back to the content script message channel.
  try {
    const response = (await chrome.tabs.sendMessage(tabId, {
      type: 'GET_VIDEO_STATUS',
    })) as ExtensionResponse
    const status = response.ok
      ? (response.payload as VideoStatus | undefined)
      : undefined
    if (status) {
      return status
    }
  } catch (error) {
    console.warn('[spandan] message query failed', error)
  }

  return null
}
