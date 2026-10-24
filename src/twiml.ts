import type { FastifyInstance, FastifyRequest } from "fastify";
import twilio from "twilio";
import { config, type Persona } from "./config.js";
import { CallSession, sessions } from "./call/session.js";

const { VoiceResponse } = twilio.twiml;

const client =
  config.twilioAccountSid && config.twilioAuthToken
    ? twilio(config.twilioAccountSid, config.twilioAuthToken)
    : undefined;

function host(req: FastifyRequest): string {
  return config.publicHost ?? req.headers.host ?? "localhost";
}

/** Twilio ignores query strings on <Stream url>, so routing info rides in <Parameter>. */
export function streamTwiml(wsHost: string, sessionId: string, leg: "A" | "B"): string {
  const response = new VoiceResponse();
  const stream = response.connect().stream({ url: `wss://${wsHost}/media` });
  stream.parameter({ name: "sid", value: sessionId });
  stream.parameter({ name: "leg", value: leg });
  return response.toString();
}

function sayAndHangup(text: string): string {
  const response = new VoiceResponse();
  response.say(text);
  response.hangup();
  return response.toString();
}

async function hangup(callSid: string | undefined, text?: string): Promise<void> {
  if (!client || !callSid) return;
  try {
    await client.calls(callSid).update(text ? { twiml: sayAndHangup(text) } : { status: "completed" });
  } catch (err) {
    console.warn(`hangup ${callSid} failed: ${(err as Error).message}`);
  }
}

export function registerTwimlRoutes(app: FastifyInstance): void {
  app.post("/voice/inbound", async (req, reply) => {
    const body = req.body as Record<string, string>;
    const persona: Persona | undefined = config.personas[body.To];
    reply.type("text/xml");

    if (!persona) {
      req.log.warn(`no persona configured for ${body.To}`);
      return sayAndHangup("This number is not configured.");
    }

    const sessionId = body.CallSid;
    const session = new CallSession(sessionId, persona, config.bridgeMode, config.defaultCallerLang);
    sessions.set(sessionId, session);
    session.log(`inbound from ${body.From} to ${persona.name} (${persona.lang}), mode=${config.bridgeMode}`);
    session.on("ended", () => {
      sessions.delete(sessionId);
      hangup(session.legs.A?.callSid ?? sessionId);
      hangup(session.legs.B?.callSid);
    });

    if (config.bridgeMode !== "echo") {
      if (!client) throw new Error("TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN required to dial leg B");
      // Dial the persona's real phone while the caller's stream comes up.
      client.calls
        .create({
          to: persona.forwardTo,
          from: body.To,
          twiml: streamTwiml(host(req), sessionId, "B"),
          timeout: config.ringTimeoutSec,
          statusCallback: `https://${host(req)}/voice/status?sid=${encodeURIComponent(sessionId)}`,
          statusCallbackEvent: ["completed"],
        })
        .catch((err) => {
          session.log(`dial B failed: ${err.message}`);
          hangup(sessionId, `Sorry, ${persona.name} could not be reached.`);
        });
    }

    return streamTwiml(host(req), sessionId, "A");
  });

  app.post("/voice/status", async (req, reply) => {
    const { sid } = req.query as { sid?: string };
    const body = req.body as Record<string, string>;
    const session = sid ? sessions.get(sid) : undefined;
    if (session && !session.legs.B && ["busy", "no-answer", "failed", "canceled"].includes(body.CallStatus)) {
      session.log(`leg B ${body.CallStatus}`);
      await hangup(sid, `Sorry, ${session.persona.name} is not available right now.`);
      session.end(`leg B ${body.CallStatus}`);
    }
    reply.code(204).send();
  });
}
