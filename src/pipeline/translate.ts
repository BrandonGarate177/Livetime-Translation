// #7: streaming translation behind TRANSLATE_PROVIDER (groq | anthropic | deepl | mock), with DeepL as the
// fallback when a streaming provider fails before it has produced anything.
import Anthropic from "@anthropic-ai/sdk";
import { config, type Lang, type TranslateProvider } from "../config.js";
import type { TranslateOpts } from "./contract.js";

export interface TranslateBackend {
  name: string;
  run(opts: TranslateOpts): AsyncIterable<string>;
}

export interface Backends {
  primary: TranslateBackend | TranslateProvider;
  fallback?: TranslateBackend | TranslateProvider;
}

export function defaultBackends(): Backends {
  const primary = config.translateProvider;
  const fallback = primary !== "deepl" && primary !== "mock" && config.deeplApiKey ? "deepl" : undefined;
  return { primary, fallback };
}

export async function* translate(opts: TranslateOpts, deps: Backends = defaultBackends()): AsyncIterable<string> {
  if (opts.signal?.aborted) return;
  const primary = resolve(deps.primary);
  const fallback = deps.fallback ? resolve(deps.fallback) : undefined;
  let produced = false;
  try {
    for await (const chunk of primary.run(opts)) {
      if (opts.signal?.aborted) return;
      if (!chunk) continue;
      produced = true;
      yield chunk;
    }
    return;
  } catch (err) {
    if (opts.signal?.aborted) return;
    // Once words have been spoken we can't take them back, so a mid-stream failure is final.
    if (produced || !fallback) throw err;
    console.warn(`translate via ${primary.name} failed (${(err as Error).message}); using ${fallback.name}`);
  }
  for await (const chunk of fallback.run(opts)) {
    if (opts.signal?.aborted) return;
    if (chunk) yield chunk;
  }
}

/** Pays the TLS handshake and any model cold start before the first real utterance. Never throws. */
export async function prewarm(deps: Backends = defaultBackends()): Promise<void> {
  try {
    for await (const _ of translate({ text: "Hello.", src: "en", dst: "uk", history: [] }, deps)) {
      // drain
    }
  } catch (err) {
    console.warn(`translate prewarm failed: ${(err as Error).message}`);
  }
}

function resolve(b: TranslateBackend | TranslateProvider): TranslateBackend {
  if (typeof b !== "string") return b;
  switch (b) {
    case "groq":
      return groq;
    case "anthropic":
      return anthropic;
    case "deepl":
      return deepl;
    case "mock":
      return mock;
  }
}

// --- chat-model prompt ---

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

const LANG_NAME: Record<Lang, string> = { en: "English", es: "Spanish", uk: "Ukrainian", ru: "Russian" };

export function buildChatMessages(opts: TranslateOpts): { system: string; messages: ChatMessage[] } {
  const system =
    `You are a simultaneous interpreter on a live phone call between a ${LANG_NAME[opts.src]} speaker and a ` +
    `${LANG_NAME[opts.dst]} speaker. Each user message is one utterance, prefixed with its direction, e.g. "[en→uk]". ` +
    `Translate it into the target language exactly as the speaker would have said it: conversational register, same ` +
    `tone, keep names and numbers. Output only the translation. No quotes, no notes, no explanations.`;
  const messages: ChatMessage[] = [];
  for (const turn of opts.history) {
    const dst = turn.src === opts.src ? opts.dst : opts.src;
    messages.push({ role: "user", content: `[${turn.src}→${dst}] ${turn.text}` });
    messages.push({ role: "assistant", content: turn.translation });
  }
  messages.push({ role: "user", content: `[${opts.src}→${opts.dst}] ${opts.text}` });
  return { system, messages };
}

/** One line of an OpenAI-style SSE stream → content delta ("" if none), or null at [DONE]. */
export function parseSseLine(line: string): string | null {
  if (!line.startsWith("data:")) return "";
  const data = line.slice(5).trim();
  if (data === "[DONE]") return null;
  try {
    return JSON.parse(data).choices?.[0]?.delta?.content ?? "";
  } catch {
    return "";
  }
}

// --- backends ---

const groq: TranslateBackend = {
  name: "groq",
  async *run(opts) {
    const { system, messages } = buildChatMessages(opts);
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${config.groqApiKey}`, "Content-Type": "application/json" },
      signal: opts.signal,
      body: JSON.stringify({
        model: config.groqModel,
        messages: [{ role: "system", content: system }, ...messages],
        stream: true,
        temperature: 0.2,
        max_tokens: 400,
      }),
    });
    if (!res.ok || !res.body) throw new Error(`groq ${res.status}: ${(await res.text()).slice(0, 200)}`);
    let pending = "";
    for await (const chunk of res.body.pipeThrough(new TextDecoderStream())) {
      pending += chunk;
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) {
        const delta = parseSseLine(line);
        if (delta === null) return;
        if (delta) yield delta;
      }
    }
  },
};

let anthropicClient: Anthropic | undefined;

const anthropic: TranslateBackend = {
  name: "anthropic",
  async *run(opts) {
    anthropicClient ??= new Anthropic({ apiKey: config.anthropicApiKey });
    const { system, messages } = buildChatMessages(opts);
    // Thinking off and effort low: a one-sentence translation needs time-to-first-token, not deliberation.
    const stream = anthropicClient.messages.stream(
      {
        model: config.anthropicModel,
        max_tokens: 1024,
        system,
        messages,
        thinking: { type: "disabled" },
        output_config: { effort: "low" },
      },
      { signal: opts.signal },
    );
    for await (const event of stream) {
      if (event.type === "content_block_delta" && event.delta.type === "text_delta") yield event.delta.text;
    }
    if ((await stream.finalMessage()).stop_reason === "refusal") throw new Error("anthropic refused the translation");
  },
};

const deepl: TranslateBackend = {
  name: "deepl",
  async *run(opts) {
    // Free-tier keys end in ":fx" and live on a separate host.
    const host = config.deeplApiKey.endsWith(":fx") ? "api-free.deepl.com" : "api.deepl.com";
    const res = await fetch(`https://${host}/v2/translate`, {
      method: "POST",
      headers: { Authorization: `DeepL-Auth-Key ${config.deeplApiKey}`, "Content-Type": "application/json" },
      signal: opts.signal,
      body: JSON.stringify({
        text: [opts.text],
        source_lang: opts.src.toUpperCase(),
        target_lang: opts.dst.toUpperCase(),
        context: opts.history.map((h) => h.text).join("\n") || undefined,
      }),
    });
    if (!res.ok) throw new Error(`deepl ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const body = (await res.json()) as { translations: { text: string }[] };
    yield body.translations[0]?.text ?? "";
  },
};

/** Keeps a call flowing with no LLM key: the listener hears the original text tagged with the target language. */
const mock: TranslateBackend = {
  name: "mock",
  async *run(opts) {
    for (const word of `[${opts.dst}] ${opts.text}`.split(/(?<= )/)) yield word;
  },
};
