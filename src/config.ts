import "dotenv/config";

export type Lang = "en" | "es" | "uk" | "ru";
export type BridgeMode = "echo" | "raw" | "translate";

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

export const config = {
  port: Number(process.env.PORT ?? 3000),
  publicHost: process.env.PUBLIC_HOST || undefined,
  twilioAccountSid: process.env.TWILIO_ACCOUNT_SID ?? "",
  twilioAuthToken: process.env.TWILIO_AUTH_TOKEN ?? "",
  bridgeMode: (process.env.BRIDGE_MODE ?? "echo") as BridgeMode,
  personas: parsePersonas(process.env.PERSONAS_JSON),
  defaultCallerLang: (process.env.DEFAULT_CALLER_LANG ?? "en") as Lang,
  ringTimeoutSec: Number(process.env.RING_TIMEOUT_SEC ?? 25),
};
