import Fastify from "fastify";
import formbody from "@fastify/formbody";
import websocket from "@fastify/websocket";
import { config } from "./config.js";
import { Leg, type LegId } from "./call/leg.js";
import { CallSession, sessions } from "./call/session.js";
import { registerTwimlRoutes } from "./twiml.js";
import { loadPipeline } from "./pipeline/index.js";

const pipeline = config.bridgeMode === "translate" ? await loadPipeline() : undefined;

const app = Fastify({ logger: { level: "info" } });
await app.register(formbody);
await app.register(websocket);

registerTwimlRoutes(app, pipeline);

app.get("/health", async () => ({ ok: true, mode: config.bridgeMode, sessions: sessions.size }));

app.get("/media", { websocket: true }, (socket) => {
  // The leg doesn't know its session until Twilio's "start" event delivers the custom parameters.
  socket.once("message", (data) => {
    const first = JSON.parse(data.toString());
    if (first.event === "connected") {
      socket.once("message", (next) => bind(JSON.parse(next.toString())));
    } else {
      bind(first);
    }
  });

  function bind(start: any): void {
    if (start.event !== "start") {
      socket.close();
      return;
    }
    const params = start.start.customParameters ?? {};
    const legId = params.leg as LegId;
    let session = sessions.get(params.sid);
    if (!session && params.sim === "1") {
      // The simulator skips the /voice/inbound webhook, so it describes the persona inline.
      const persona = config.personas[params.to] ?? { name: "Sim", lang: "uk", forwardTo: "" };
      session = new CallSession(params.sid, persona, config.bridgeMode, config.defaultCallerLang, pipeline);
      sessions.set(params.sid, session);
      session.on("ended", () => sessions.delete(params.sid));
    }
    if (!session || (legId !== "A" && legId !== "B")) {
      app.log.warn(`media stream for unknown session ${params.sid} leg ${legId}`);
      socket.close();
      return;
    }
    const leg = new Leg(legId, socket, start.start);
    session.attach(leg);
    session.on("ended", () => leg.close());
  }
});

await app.listen({ port: config.port, host: "0.0.0.0" });
app.log.info(`mode=${config.bridgeMode} pipeline=${pipeline?.name ?? "none"} personas=${Object.keys(config.personas).join(",") || "none"}`);
