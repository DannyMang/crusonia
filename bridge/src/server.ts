// Local-only HTTP surface (node:http, so it runs on Bun and Node alike), bound to 127.0.0.1 by default and never
// published: the Docker healthcheck and the operator CLI (`docker exec ... bun src/cli.ts`) use it from inside.
//   GET  /health        liveness, Spectrum connection and poll state (no secrets, no phone numbers)
//   POST /notify        signed with BRIDGE_SECRET: text the owner once (operator test message; the Worker never calls it)
//   POST /mock/inbound  SPECTRUM_MODE=mock only, signed: simulate an inbound event (a tapback), returns the replies
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { z } from "zod";
import { NOTIFY_PATH, type Bridge, type HttpResult } from "./bridge.ts";
import { SIGNATURE_HEADER, TIMESTAMP_HEADER, verify } from "./hmac.ts";
import { describeError, log } from "./log.ts";
import type { MockMessenger } from "./messenger.ts";

const MAX_BODY_BYTES = 64 * 1024;
export const MOCK_INBOUND_PATH = "/mock/inbound";

class BodyTooLarge extends Error {}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new BodyTooLarge());
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function send(res: ServerResponse, result: HttpResult) {
  const body = JSON.stringify(result.body);
  res.writeHead(result.status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(body);
}

const header = (req: IncomingMessage) => ({
  get: (name: string) => {
    const v = req.headers[name.toLowerCase()];
    return Array.isArray(v) ? v[0] : v;
  },
});

const MockInbound = z.object({
  from: z.string().min(1).max(320),
  text: z.string().max(12_000).optional(),
  id: z.string().max(200).optional(),
  contentType: z.string().max(40).optional(),
  reaction: z.object({ emoji: z.string().max(40), targetId: z.string().max(200).optional() }).optional(),
});

export function buildServer(opts: { bridge: Bridge; secret: string; mock?: MockMessenger; health?: () => HttpResult }): Server {
  const { bridge, secret, mock } = opts;
  const health = opts.health ?? (() => bridge.health());
  return createServer(async (req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    try {
      if (req.method === "GET" && (path === "/health" || path === "/")) return send(res, health());
      if (req.method === "POST" && path === NOTIFY_PATH) {
        const raw = await readBody(req);
        return send(res, await bridge.handleNotify(raw, header(req)));
      }
      if (mock && req.method === "POST" && path === MOCK_INBOUND_PATH) {
        const raw = await readBody(req);
        const h = header(req);
        const verified = verify({ secret, path: MOCK_INBOUND_PATH, body: raw, timestamp: h.get(TIMESTAMP_HEADER), signature: h.get(SIGNATURE_HEADER) });
        if (!verified.ok) return send(res, { status: 401, body: { error: { code: "invalid_signature", message: verified.reason } } });
        const input = MockInbound.safeParse(JSON.parse(raw));
        if (!input.success) return send(res, { status: 400, body: { error: { code: "invalid_payload", message: input.error.message } } });
        const before = mock.outbox.length;
        const { reaction, ...rest } = input.data;
        await mock.inject({ ...rest, ...(reaction ? { reaction: { emoji: reaction.emoji, targetId: reaction.targetId } } : {}) });
        return send(res, { status: 200, body: { ok: true, replies: mock.outbox.slice(before) } });
      }
      return send(res, { status: 404, body: { error: { code: "not_found", message: `No route for ${req.method} ${path}` } } });
    } catch (err) {
      if (err instanceof BodyTooLarge) return send(res, { status: 413, body: { error: { code: "payload_too_large", message: "Body too large" } } });
      log.error("request failed", { path, error: describeError(err) });
      if (!res.headersSent) send(res, { status: 500, body: { error: { code: "internal_error", message: "Internal error" } } });
    }
  });
}
