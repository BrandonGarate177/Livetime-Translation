import { EventEmitter } from "node:events";
import { config, type BridgeMode, type Lang, type Persona } from "../config.js";
import type { Pipeline, Turn } from "../pipeline/contract.js";
import { Direction, type Timing } from "./direction.js";
import { Leg, type LegId } from "./leg.js";

/** `transcript`/`translation`/`timing` feed the dashboard (#13) so it never reaches into the pipeline. */
export interface SessionEvents {
  ended: [];
  transcript: [e: { leg: LegId; text: string; isFinal: boolean }];
  translation: [e: { leg: LegId; text: string }];
  timing: [e: Timing & { leg: LegId }];
}

/**
 * One translated call: leg A is the caller (judge), leg B is the persona's real phone.
 * The legs are never bridged by Twilio; every byte the other side hears is sent from here.
 */
export class CallSession extends EventEmitter<SessionEvents> {
  legs: Partial<Record<LegId, Leg>> = {};
  callerLang: Lang;
  private directions: Partial<Record<LegId, Direction>> = {};
  private readonly history: Turn[] = [];
  private ended = false;

  constructor(
    readonly id: string,
    readonly persona: Persona,
    readonly mode: BridgeMode,
    defaultCallerLang: Lang,
    private readonly pipeline?: Pipeline,
  ) {
    super();
    this.callerLang = defaultCallerLang;
    if (mode === "translate" && !pipeline) throw new Error("BRIDGE_MODE=translate needs a pipeline");
  }

  attach(leg: Leg): void {
    this.legs[leg.id] = leg;
    this.log(`leg ${leg.id} connected (${leg.callSid})`);
    leg.on("stop", () => this.end(`leg ${leg.id} hung up`));

    if (this.mode === "echo") {
      leg.on("audio", (frame) => leg.sendAudio(frame));
    } else if (this.mode === "raw") {
      this.relayRaw(leg);
    } else {
      this.attachTranslated(leg);
    }
  }

  /** Each leg gets its own direction: this leg speaks, the other leg listens. */
  private attachTranslated(leg: Leg): void {
    const srcLang = leg.id === "A" ? this.callerLang : this.persona.lang;
    const dstLang = leg.id === "A" ? this.persona.lang : this.callerLang;
    if (srcLang === dstLang) {
      this.log(`leg ${leg.id}: both sides speak ${srcLang}; relaying raw audio`);
      this.relayRaw(leg);
      return;
    }
    // B hears the judge in a stock voice until the live clone (#12) lands; A hears the persona's own clone.
    const voiceId = leg.id === "A" ? config.fallbackVoiceM : this.persona.voiceId || config.fallbackVoiceF;
    const direction = new Direction({
      pipeline: this.pipeline!,
      from: leg,
      to: () => this.other(leg.id),
      srcLang,
      dstLang,
      voiceId,
      history: this.history,
      log: (msg) => this.log(`${leg.id}→${leg.id === "A" ? "B" : "A"} ${msg}`),
    });
    direction.on("transcript", (e) => this.emit("transcript", { leg: leg.id, ...e }));
    direction.on("translation", (e) => {
      this.log(`${leg.id} ${srcLang}→${dstLang}: ${e.text}`);
      this.emit("translation", { leg: leg.id, ...e });
    });
    direction.on("timing", (e) => this.emit("timing", { leg: leg.id, ...e }));
    direction.start();
    this.directions[leg.id] = direction;
  }

  private relayRaw(leg: Leg): void {
    leg.on("audio", (frame) => this.other(leg.id)?.sendAudio(frame));
  }

  other(id: LegId): Leg | undefined {
    return this.legs[id === "A" ? "B" : "A"];
  }

  end(reason: string): void {
    if (this.ended) return;
    this.ended = true;
    this.log(`ended: ${reason}`);
    for (const d of Object.values(this.directions)) d.close();
    this.emit("ended");
  }

  get isEnded(): boolean {
    return this.ended;
  }

  log(msg: string): void {
    console.log(`[${this.id.slice(-6)}] ${msg}`);
  }
}

export const sessions = new Map<string, CallSession>();
