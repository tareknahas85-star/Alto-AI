// True for a tiny model (under 4B parameters) that cannot drive tools, judged from the REAL provider model id
// ("qwen3:1.7b", "llama3.2:1b"). Strong families are never judged by size.
export const isTinyModelId = (id: string): boolean =>
  !/gemini|gpt|claude|sonnet|opus|haiku/i.test(id) && /(?:^|[:/_-])(?:0?\.\d+|[1-3](?:\.\d+)?)b(?![a-z0-9])/i.test(id)
