import { queryVideoStatus } from '@/lib/video'
import {
  getSiteLabel,
  isMusicTab,
  matchesWhitelist,
  queryAudibleTabs,
} from '@/lib/tabs'
import type {
  ExtensionSettings,
  ExtensionState,
  MusicTab,
  StatusPayload,
  VideoStatus,
} from '@/types'

/**
 * Compute the status payload shown in the popup and options page.
 *
 * This function is shared between the background service worker and the popup
 * so both contexts report identical status without requiring a round-trip.
 */
export function computeStatus(
  settings: ExtensionSettings,
  state: ExtensionState,
  audibleTabs: chrome.tabs.Tab[],
  videoStatus?: VideoStatus,
): StatusPayload {
  if (!settings.enabled) {
    return {
      enabled: false,
      musicTab: state.musicTab,
      status: 'disabled',
      reason: 'Automatic music control is disabled.',
      waitingSeconds: null,
    }
  }

  if (!state.musicTab) {
    return {
      enabled: true,
      musicTab: null,
      status: 'no_music_tab',
      reason: 'Choose a YouTube tab to start.',
      waitingSeconds: null,
    }
  }

  if (state.manuallyPaused) {
    return {
      enabled: true,
      musicTab: state.musicTab,
      status: 'manual_pause',
      reason: 'Play or unmute to resume auto-control.',
      waitingSeconds: null,
    }
  }

  const nonMusicAudibleTabs = getWhitelistedNonMusicTabs(
    audibleTabs,
    state.musicTab,
    settings.whitelist,
  )

  if (nonMusicAudibleTabs.length > 0) {
    const site = getSiteLabel(nonMusicAudibleTabs[0].url)
    return {
      enabled: true,
      musicTab: state.musicTab,
      status: 'paused',
      reason: `${site} is playing.`,
      waitingSeconds: null,
    }
  }

  if (state.waitingToResumeUntil) {
    const remainingMs = state.waitingToResumeUntil - Date.now()
    const remainingSeconds = Math.max(0, Math.ceil(remainingMs / 1000))
    return {
      enabled: true,
      musicTab: state.musicTab,
      status: 'waiting',
      reason: `Resuming in ${remainingSeconds} ${remainingSeconds === 1 ? 'second' : 'seconds'}.`,
      waitingSeconds: remainingSeconds,
    }
  }

  // Prefer the actual video state when available; otherwise fall back to the
  // cached UI value.
  const isVideoPlaying = videoStatus?.isPlaying ?? state.isPlaying

  if (isVideoPlaying) {
    return {
      enabled: true,
      musicTab: state.musicTab,
      status: 'playing',
      reason: 'Playing normally.',
      waitingSeconds: null,
    }
  }

  return {
    enabled: true,
    musicTab: state.musicTab,
    status: 'paused',
    reason: 'Resumes when the music tab is ready.',
    waitingSeconds: null,
  }
}

/**
 * Return audible tabs that are allowed to pause the music tab.
 *
 * Filters out the music tab itself and applies the user whitelist.
 */
export function getWhitelistedNonMusicTabs(
  audibleTabs: chrome.tabs.Tab[],
  musicTab: MusicTab | null,
  whitelist: string[],
): chrome.tabs.Tab[] {
  return audibleTabs.filter(
    (tab) =>
      tab.id !== undefined &&
      !isMusicTab(tab.id, musicTab) &&
      matchesWhitelist(tab.url, whitelist),
  )
}

/**
 * Convenience helper that fetches audible tabs, queries the real video state,
 * and computes status in one call.
 */
export async function getComputedStatus(
  settings: ExtensionSettings,
  state: ExtensionState,
): Promise<StatusPayload> {
  const [audibleTabs, videoStatus] = await Promise.all([
    queryAudibleTabs(),
    state.musicTab?.tabId ? queryVideoStatus(state.musicTab.tabId) : null,
  ])
  return computeStatus(settings, state, audibleTabs, videoStatus ?? undefined)
}
