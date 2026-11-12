// ترجمة فورية صوتية عبر Gemini Live (موديل الترجمة). الصوت بيدخل 16kHz PCM وبيطلع صوت مترجم 24kHz مع تفريغ نصي للأصل وللترجمة.
// الرسائل المُستقبَلة نفس صيغة Live العادية، فبنستعمل parseLiveAll (inputTranscription -> userText, outputTranscription -> modelText).

export const TRANSLATE_MODEL = 'models/gemini-3.5-live-translate-preview'

export interface TranslateLang { code: string; label: string }
// رموز BCP-47 المدعومة بموديل الترجمة (جزء من اللائحة؛ الموديل بيدعم 70+ لغة).
export const TRANSLATE_LANGS: TranslateLang[] = [
  { code: 'ar', label: 'العربية' },
  { code: 'en', label: 'English' },
  { code: 'fr', label: 'Français' },
  { code: 'es', label: 'Español' },
  { code: 'de', label: 'Deutsch' },
  { code: 'tr', label: 'Türkçe' },
  { code: 'ru', label: 'Русский' },
  { code: 'fa', label: 'فارسی' },
  { code: 'ur', label: 'اردو' },
  { code: 'hi', label: 'हिन्दी' },
  { code: 'it', label: 'Italiano' },
  { code: 'pt-BR', label: 'Português (BR)' },
  { code: 'nl', label: 'Nederlands' },
  { code: 'pl', label: 'Polski' },
  { code: 'uk', label: 'Українська' },
  { code: 'zh-Hans', label: '中文 (简体)' },
  { code: 'ja', label: '日本語' },
  { code: 'ko', label: '한국어' }
]

export function isTranslateLang(code: unknown): code is string {
  return typeof code === 'string' && TRANSLATE_LANGS.some((l) => l.code === code)
}

/** First message on the socket. translationConfig must sit inside generationConfig. */
export function translateSetup(target: string, echo: boolean): Record<string, unknown> {
  return {
    setup: {
      model: TRANSLATE_MODEL,
      generationConfig: {
        responseModalities: ['AUDIO'],
        inputAudioTranscription: {},
        outputAudioTranscription: {},
        translationConfig: { targetLanguageCode: target, echoTargetLanguage: echo }
      }
    }
  }
}