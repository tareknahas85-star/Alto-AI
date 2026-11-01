// Each media site gets its own browser session in the side panel, so signing in to one never leaks into another
// and each can be cleared on its own. Pages that belong to no known service share the default session.

export const SIDE_DEFAULT_PARTITION = 'persist:side-browser'

export interface SideService { id: string; domains: string[] }

export const SIDE_SERVICES: SideService[] = [
  { id: 'leonardo', domains: ['leonardo.ai'] },
  { id: 'ideogram', domains: ['ideogram.ai'] },
  { id: 'designer', domains: ['designer.microsoft.com'] },
  { id: 'canva', domains: ['canva.com'] },
  { id: 'morphic', domains: ['morphic.com', 'morphic.sh'] }
]

export const partitionOfService = (id: string): string => 'persist:side-' + id

function hostOf(url: string): string {
  try { return new URL(url).hostname.toLowerCase() } catch { return '' }
}

/** The service whose site this address belongs to, or null for any other site. */
export function serviceForUrl(url: string): SideService | null {
  const h = hostOf(url)
  if (!h) return null
  return SIDE_SERVICES.find((s) => s.domains.some((d) => h === d || h.endsWith('.' + d))) ?? null
}

export function partitionForUrl(url: string): string {
  const s = serviceForUrl(url)
  return s ? partitionOfService(s.id) : SIDE_DEFAULT_PARTITION
}
