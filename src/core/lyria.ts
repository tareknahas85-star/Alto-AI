// Lyria 3.5 (Gemini API, Interactions endpoint): music from a text description. The key goes in x-goog-api-key.
export const LYRIA_URL = 'https://generativelanguage.googleapis.com/v1beta/interactions'
export const LYRIA_MODEL = 'lyria-3.5'

export function lyriaRequest(prompt: string): { model: string; input: string } {
  return { model: LYRIA_MODEL, input: prompt }
}

/** Pulls the first audio block (base64) out of an Interaction response, or null. Text blocks (lyrics) are ignored. */
export function lyriaAudio(j: unknown): { data: string; mimeType: string } | null {
  const steps = (j as { steps?: unknown[] } | null)?.steps
  if (!Array.isArray(steps)) return null
  for (const s of steps) {
    const st = s as { type?: string; content?: unknown[] }
    if (st.type !== 'model_output' || !Array.isArray(st.content)) continue
    for (const c of st.content) {
      const b = c as { type?: string; data?: string; mime_type?: string }
      if (b.type === 'audio' && typeof b.data === 'string' && b.data.length > 0) return { data: b.data, mimeType: typeof b.mime_type === 'string' ? b.mime_type : 'audio/mpeg' }
    }
  }
  return null
}