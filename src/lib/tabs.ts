import type { MusicTab } from '@/types'

/**
 * Tab utility helpers used by the background service worker.
 *
 * Keeping these in a dedicated module keeps the service worker focused on
 * orchestration and makes the logic easy to unit-test in later phases.
 */

const YOUTUBE_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'music.youtube.com',
  'youtube-nocookie.com',
  'www.youtube-nocookie.com',
  'youtu.be',
])

/**
 * Returns true if the URL belongs to a YouTube property.
 *
 * The popup uses this validation to reject non-YouTube music tabs, and the
 * background worker uses it to clear the music tab if it navigates away from
 * YouTube.
 */
export function isYouTubeUrl(url: string | undefined): boolean {
  if (!url) return false
  try {
    const { hostname } = new URL(url)
    return YOUTUBE_HOSTS.has(hostname)
  } catch {
    return false
  }
}

/**
 * Build a stable matching key from a URL.
 *
 * We ignore search params so that a YouTube video still matches after the
 * page adds or changes parameters (e.g., `?t=123`). This makes restart
 * restoration more reliable.
 */
export function getUrlKey(url: string): string {
  const parsed = new URL(url)
  return `${parsed.origin}${parsed.pathname}`
}

/**
 * Extract the hostname from a URL, or return undefined if the URL is invalid.
 */
export function getHostname(url: string | undefined): string | undefined {
  if (!url) return undefined
  try {
    return new URL(url).hostname
  } catch {
    return undefined
  }
}

/**
 * Normalize a whitelist entry to a hostname.
 *
 * Users may enter "youtube.com", "https://www.youtube.com/", or
 * "www.youtube.com". This strips protocols and paths.
 */
export function normalizeWhitelistEntry(entry: string): string {
  const trimmed = entry.trim().toLowerCase()
  if (!trimmed) return ''

  // If it looks like a bare hostname, return it as-is.
  if (!trimmed.includes('/')) {
    return trimmed.replace(/^www\./, '')
  }

  try {
    return new URL(trimmed).hostname.replace(/^www\./, '')
  } catch {
    return trimmed.replace(/^www\./, '')
  }
}

/**
 * Returns true if the URL matches the whitelist.
 *
 * An empty whitelist means "allow all websites".
 */
export function matchesWhitelist(
  url: string | undefined,
  whitelist: string[],
): boolean {
  if (whitelist.length === 0) return true

  const hostname = getHostname(url)
  if (!hostname) return false

  const normalizedHost = hostname.toLowerCase()
  const normalizedEntries = whitelist.map(normalizeWhitelistEntry).filter(Boolean)

  return normalizedEntries.some((entry) => {
    // Exact match: "youtube.com" matches "youtube.com".
    if (normalizedHost === entry) return true

    // Subdomain match: "youtube.com" matches "www.youtube.com" and
    // "music.youtube.com".
    if (normalizedHost.endsWith(`.${entry}`)) return true

    return false
  })
}

// Proper names for common audio sources; anything else shows its hostname.
const SITE_LABELS: Record<string, string> = {
  'youtube.com': 'YouTube',
  'music.youtube.com': 'YouTube Music',
  'youtube-nocookie.com': 'YouTube',
  'spotify.com': 'Spotify',
  'open.spotify.com': 'Spotify',
  'netflix.com': 'Netflix',
  'primevideo.com': 'Prime Video',
  'udemy.com': 'Udemy',
  'coursera.org': 'Coursera',
  'twitch.tv': 'Twitch',
  'vimeo.com': 'Vimeo',
  'soundcloud.com': 'SoundCloud',
  'meet.google.com': 'Google Meet',
  'app.zoom.us': 'Zoom',
}

/**
 * Short, readable name for the site a URL belongs to ("YouTube", "udemy.com").
 */
export function getSiteLabel(url: string | undefined): string {
  const hostname = getHostname(url)?.toLowerCase().replace(/^www\./, '')
  if (!hostname) return 'Another tab'
  return SITE_LABELS[hostname] ?? hostname
}

/**
 * Clean a YouTube tab title for display: drops the unread-count prefix
 * ("(3) ") and the " - YouTube" suffix.
 */
export function cleanTabTitle(title: string): string {
  return (
    title
      .replace(/^\(\d+\)\s*/, '')
      .replace(/\s*[-|]\s*YouTube( Music)?\s*$/i, '')
      .trim() || title
  )
}

/**
 * Query all tabs that are currently producing audio.
 */
export async function queryAudibleTabs(): Promise<chrome.tabs.Tab[]> {
  return chrome.tabs.query({ audible: true })
}

/**
 * Try to find an existing tab that matches the saved music-tab URL.
 *
 * Used after a browser restart, when tab IDs have been reset.
 */
export async function findTabByUrl(
  url: string,
): Promise<chrome.tabs.Tab | undefined> {
  const target = getUrlKey(url)
  const tabs = await chrome.tabs.query({})
  return tabs.find((tab) => tab.url !== undefined && getUrlKey(tab.url) === target)
}

/**
 * Returns true if the given tab ID is the currently selected music tab.
 */
export function isMusicTab(tabId: number, musicTab: MusicTab | null): boolean {
  return musicTab !== null && musicTab.tabId === tabId
}
