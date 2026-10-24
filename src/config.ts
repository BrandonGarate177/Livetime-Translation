import "dotenv/config";

export type Lang = "en" | "es" | "uk" | "ru";
export type BridgeMode = "echo" | "raw" | "translate";
export type SttProvider = "deepgram" | "mock";
export type TranslateProvider = "groq" | "anthropic" | "deepl" | "mock";
export type TtsProvider = "elevenlabs" | "mock";

export interface Persona {
  name: string;
  lang: Lang;
  forwardTo: string;
  voiceId?: string;
}

function parsePersonas(raw: string | undefined): Record<string, Persona> {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`PERSONAS_JSON is not valid JSON: ${(err as Error).message}`);
  }
}

/** A vendor is used only when its flag names it AND its key is present; otherwise the mock keeps the call alive. */
function provider<T extends string>(name: string | undefined, fallback: T, keyed: Record<string, string>): T {
  const wanted = (name ?? fallback) as T;
  if (wanted === "mock" || keyed[wanted]) return wanted;
  console.warn(`${wanted} selected but its API key is empty; using mock`);
  return "mock" as T;
}

const env = process.env;

export const config = {
  port: Number(env.PORT ?? 3000),
  publicHost: env.PUBLIC_HOST || undefined,
  twilioAccountSid: env.TWILIO_ACCOUNT_SID ?? "",
  twilioAuthToken: env.TWILIO_AUTH_TOKEN ?? "",
  bridgeMode: (env.BRIDGE_MODE ?? "echo") as BridgeMode,
  personas: parsePersonas(env.PERSONAS_JSON),
  defaultCallerLang: (env.DEFAULT_CALLER_LANG ?? "en") as Lang,
  ringTimeoutSec: Number(env.RING_TIMEOUT_SEC ?? 25),

  // --- pipeline ---
  /** real = vendor modules from #6/#7/#8; fake = offline stand-ins (macOS say) for the simulator and tests. */
  pipeline: (env.PIPELINE ?? "real") as "real" | "fake",
  deepgramApiKey: env.DEEPGRAM_API_KEY ?? "",
  deepgramModel: env.DEEPGRAM_MODEL ?? "nova-3",
  sttProvider: provider<SttProvider>(env.STT_PROVIDER, "deepgram", { deepgram: env.DEEPGRAM_API_KEY ?? "" }),

  translateProvider: provider<TranslateProvider>(env.TRANSLATE_PROVIDER, "groq", {
    groq: env.GROQ_API_KEY ?? "",
    anthropic: env.ANTHROPIC_API_KEY ?? "",
    deepl: env.DEEPL_API_KEY ?? "",
  }),
  groqApiKey: env.GROQ_API_KEY ?? "",
  groqModel: env.GROQ_MODEL ?? "llama-3.3-70b-versatile",
  anthropicApiKey: env.ANTHROPIC_API_KEY ?? "",
  anthropicModel: env.ANTHROPIC_MODEL ?? "claude-haiku-5-5",
  deeplApiKey: env.DEEPL_API_KEY ?? "",

  ttsProvider: provider<TtsProvider>(env.TTS_PROVIDER, "elevenlabs", { elevenlabs: env.ELEVENLABS_API_KEY ?? "" }),
  elevenlabsApiKey: env.ELEVENLABS_API_KEY ?? "",
  elevenModel: env.ELEVEN_TTS_MODEL ?? "eleven_flash_v2_5",
  fallbackVoiceM: env.FALLBACK_VOICE_M ?? "",
  fallbackVoiceF: env.FALLBACK_VOICE_F ?? "",
};
