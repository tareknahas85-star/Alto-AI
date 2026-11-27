// What a model must score on the 20-question master test to be offered as the master.
// A master must return valid JSON nearly always and decide "needs tools" correctly most of the time.
export const MIN_PARSED = 18
export const MIN_TOOLS = 16

export const qualifies = (parsed: number, tools: number, error?: string): boolean => !error && parsed >= MIN_PARSED && tools >= MIN_TOOLS
