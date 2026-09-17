import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { hostname } from "node:os";
import { server as wisp, logging } from "@mercuryworkshop/wisp-js/server";
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";

import { scramjetPath } from "@mercuryworkshop/scramjet/path";
import { libcurlPath } from "@mercuryworkshop/libcurl-transport";
import { baremuxPath } from "@mercuryworkshop/bare-mux/node";

const publicPath = fileURLToPath(new URL("../public/", import.meta.url));

// ---- Env ----
const PORT = Number.parseInt(process.env.PORT || "10000", 10) || 10000;
const HOST = process.env.HOST || "0.0.0.0";
const DNS_SERVERS = (process.env.DNS_SERVERS || "1.1.1.3,1.0.0.3")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
// Public Wisp URL injected into frontend (for Vercel-static mode).
// Empty = same-origin /wisp/ (normal Render mode).
const PUBLIC_WISP_URL = (process.env.WISP_URL || "").trim();
const BLOCKED = (process.env.BLOCKED_HOSTNAMES || "example.com")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// ---- Wisp ----
logging.set_level(logging.NONE);
Object.assign(wisp.options, {
  allow_udp_streams: false,
  dns_servers: DNS_SERVERS,
  hostname_blacklist: BLOCKED.map((h) => new RegExp(h.replace(/\./g, "\\."))),
});

const fastify = Fastify({
  // Render requires binding to 0.0.0.0:$PORT.
  // COOP/COEP are required for Scramjet (SharedArrayBuffer / worker isolation).
  serverFactory: (handler) => {
    return createServer()
      .on("request", (req, res) => {
        res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
        res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
        handler(req, res);
      })
      .on("upgrade", (req, socket, head) => {
        if (req.url && req.url.endsWith("/wisp/")) wisp.routeRequest(req, socket, head);
        else socket.end();
      });
  },
});

// Health check for Render (render.yaml healthCheckPath).
fastify.get("/health", async () => {
  return { ok: true, service: "scramjet-wisp", time: new Date().toISOString() };
});

// Dynamic frontend config. Lets the same repo work as:
//  - Render full server (WISP_URL empty -> same-origin /wisp/)
//  - Vercel static frontend pointing at Render (WISP_URL=https://xxx.onrender.com/wisp/)
fastify.get("/config.js", async (req, reply) => {
  reply.type("application/javascript; charset=utf-8");
  reply.header("Cache-Control", "no-store");
  return `window.__WISP_URL__ = ${JSON.stringify(PUBLIC_WISP_URL)};\n`;
});

fastify.register(fastifyStatic, {
  root: publicPath,
  decorateReply: true,
});

fastify.register(fastifyStatic, {
  root: scramjetPath,
  prefix: "/scram/",
  decorateReply: false,
});

fastify.register(fastifyStatic, {
  root: libcurlPath,
  prefix: "/libcurl/",
  decorateReply: false,
});

fastify.register(fastifyStatic, {
  root: baremuxPath,
  prefix: "/baremux/",
  decorateReply: false,
});

fastify.setNotFoundHandler((req, reply) => {
  return reply.code(404).type("text/html").sendFile("404.html");
});

fastify.server.on("listening", () => {
  const address = fastify.server.address();
  console.log("Listening on:");
  console.log(`\thttp://localhost:${address.port}`);
  try {
    console.log(`\thttp://${hostname()}:${address.port}`);
  } catch {}
  console.log(`Wisp endpoint: ws(s)://<host>/wisp/`);
  if (PUBLIC_WISP_URL) console.log(`Public Wisp URL override: ${PUBLIC_WISP_URL}`);
});

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

function shutdown() {
  console.log("SIGTERM received: closing HTTP server");
  fastify.close().then(() => process.exit(0));
}

fastify.listen({ port: PORT, host: HOST });
