import "dotenv/config";

export type Lang = "en" | "es" | "uk" | "ru" | "pl";
export type BridgeMode = "echo" | "raw" | "translate";
export type TranslateProvider = "groq" | "anthropic" | "deepl" | "mock";
/** flux = Deepgram Flux turn detection where the language allows (en/es/ru), Nova-3 elsewhere; nova3 = Nova-3 everywhere. */
export type SttEngine = "flux" | "nova3";

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

/** The translation vendor is used only when its key is present; otherwise the mock keeps the call alive. */
function translateProvider(name: string | undefined, keyed: Record<string, string>): TranslateProvider {
  const wanted = (name || "groq") as TranslateProvider;
  if (wanted === "mock" || keyed[wanted]) return wanted;
  console.warn(`TRANSLATE_PROVIDER=${wanted} but its API key is empty; using mock`);
  return "mock";
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
  sttEngine: (env.STT_ENGINE ?? "flux") as SttEngine,
  // Flux end-of-turn: 0.5–1.0 confidence (lower = faster, more false ends); timeout forces a turn end after silence.
  fluxEotThreshold: env.FLUX_EOT_THRESHOLD ?? "0.7",
  fluxEotTimeoutMs: env.FLUX_EOT_TIMEOUT_MS ?? "2000",
  // Languages routed to flux-general-multi (es/ru are supported). Measured no faster than Nova-3 for es, so opt-in.
  fluxMultiLangs: (env.FLUX_MULTI_LANGS ?? "").split(",").map((s) => s.trim()).filter(Boolean) as Lang[],

  translateProvider: translateProvider(env.TRANSLATE_PROVIDER, {
    groq: env.GROQ_API_KEY ?? "",
    anthropic: env.ANTHROPIC_API_KEY ?? "",
    deepl: env.DEEPL_API_KEY ?? "",
  }),
  groqApiKey: env.GROQ_API_KEY ?? "",
  groqModel: env.GROQ_MODEL ?? "qwen/qwen3.8-27b",
  // Reasoning models think before the first token; "none" (qwen) or "low" (gpt-oss) cuts ~350 ms per turn.
  // Set to empty to send no reasoning_effort at all.
  groqReasoningEffort: env.GROQ_REASONING_EFFORT ?? "none",
  anthropicApiKey: env.ANTHROPIC_API_KEY ?? "",
  anthropicModel: env.ANTHROPIC_MODEL ?? "claude-haiku-5-5",
  deeplApiKey: env.DEEPL_API_KEY ?? "",

  elevenlabsApiKey: env.ELEVENLABS_API_KEY ?? "",
  elevenModel: env.ELEVEN_TTS_MODEL ?? "eleven_flash_v2_5",
  // Pin the US region: Twilio us1 media and the demo are there; ElevenLabs quotes 100–150 ms TTFB in-region.
  elevenHost: env.ELEVENLABS_HOST ?? "api.us.elevenlabs.io",
  fallbackVoiceM: env.FALLBACK_VOICE_M ?? "",
  fallbackVoiceF: env.FALLBACK_VOICE_F ?? "",
};
