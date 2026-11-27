// Local runtimes (Ollama / LM Studio) are weaker than the signed-in or keyed models, so they are never used as the master
// and never called automatically. The user picks one by hand in the chat (with the master stopped) when he wants it.
const LOCAL_RE = /localhost|127\.0\.0\.1|\[::1\]|:11434|:1234/i

export const isLocalBaseURL = (baseURL?: string | null): boolean => LOCAL_RE.test(baseURL ?? '')
