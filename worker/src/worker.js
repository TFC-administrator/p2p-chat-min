// Minimal signaling worker using a SQLite-backed Durable Object (we do NOT write to storage).
// All SDP offer/answer state stays in-memory inside the DO and is evicted by TTL.

export default {
  async fetch(req, env) {
    const url = new URL(req.url);

    // CORS: allow calls from IPFS gateways / your .brave site
    if (req.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
          "Cache-Control": "no-store"
        }
      });
    }

    // Health
    if (url.pathname === "/health") {
      return withCORS(new Response("ok"));
    }

    // Route /room/:slug/(offer|answer|get)
    const parts = url.pathname.split("/").filter(Boolean); // e.g. ["room","abc","offer"]
    if (parts[0] === "room" && parts.length >= 3) {
      const slug = parts[1];
      const id = env.ROOM.idFromName(slug);
      const stub = env.ROOM.get(id);
      const resp = await stub.fetch(req);
      return withCORS(resp);
    }

    return withCORS(new Response("Not found", { status: 404 }));
  }
};

function withCORS(resp) {
  const h = new Headers(resp.headers);
  h.set("Access-Control-Allow-Origin", "*");
  h.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  h.set("Access-Control-Allow-Headers", "Content-Type");
  h.set("Cache-Control", "no-store");
  return new Response(resp.body, { status: resp.status, headers: h });
}

export class Room {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    // In-memory map: key -> { offer, answer, createdAt }
    this.sessions = new Map();
  }

  // Evict entries older than TTL seconds
  gc(ttlSec = 600) {
    const now = Date.now();
    for (const [k, v] of this.sessions.entries()) {
      if (!v.createdAt || now - v.createdAt > ttlSec * 1000) this.sessions.delete(k);
    }
  }

  async fetch(req) {
    const url = new URL(req.url);
    const method = req.method;
    const parts = url.pathname.split("/").filter(Boolean); // ["room", slug, action]
    const action = parts[2];
    const key = url.searchParams.get("key") || crypto.randomUUID();
    this.gc();

    // POST /room/:slug/offer  body: { offer }
    if (method === "POST" && action === "offer") {
      const offer = await req.json().catch(() => null);
      if (!offer) return json({ error: "invalid offer" }, 400);
      this.sessions.set(key, { offer, createdAt: Date.now() });
      return json({ key });
    }

    // POST /room/:slug/answer?key=...  body: { answer }
    if (method === "POST" && action === "answer") {
      const body = await req.json().catch(() => ({}));
      const entry = this.sessions.get(key);
      if (!entry || !entry.offer) return json({ error: "no offer" }, 404);
      entry.answer = body.answer;
      return json({ ok: true });
    }

    // GET /room/:slug/get?key=...
    if (method === "GET" && action === "get") {
      const entry = this.sessions.get(key);
      if (!entry) return new Response("Not found", { status: 404 });
      return json({ offer: entry.offer, answer: entry.answer || null });
    }

    return new Response("Not found", { status: 404 });
  }
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json", "Cache-Control": "no-store" }
  });
}
