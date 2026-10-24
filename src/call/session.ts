import { EventEmitter } from "node:events";
import type { BridgeMode, Lang, Persona } from "../config.js";
import { Leg, type LegId } from "./leg.js";

export interface SessionEvents {
  ended: [];
}

/**
 * One translated call: leg A is the caller (judge), leg B is the persona's real phone.
 * The legs are never bridged by Twilio; every byte the other side hears is sent from here.
 */
export class CallSession extends EventEmitter<SessionEvents> {
  legs: Partial<Record<LegId, Leg>> = {};
  callerLang: Lang;
  private ended = false;

  constructor(
    readonly id: string,
    readonly persona: Persona,
    readonly mode: BridgeMode,
    defaultCallerLang: Lang,
  ) {
    super();
    this.callerLang = defaultCallerLang;
  }

  attach(leg: Leg): void {
    this.legs[leg.id] = leg;
    this.log(`leg ${leg.id} connected (${leg.callSid})`);
    leg.on("stop", () => this.end(`leg ${leg.id} hung up`));

    if (this.mode === "echo") {
      leg.on("audio", (frame) => leg.sendAudio(frame));
    } else if (this.mode === "raw") {
      const other: LegId = leg.id === "A" ? "B" : "A";
      leg.on("audio", (frame) => this.legs[other]?.sendAudio(frame));
    } else {
      this.log(`mode "${this.mode}" not implemented yet; audio is dropped`);
    }
  }

  other(id: LegId): Leg | undefined {
    return this.legs[id === "A" ? "B" : "A"];
  }

  end(reason: string): void {
    if (this.ended) return;
    this.ended = true;
    this.log(`ended: ${reason}`);
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
