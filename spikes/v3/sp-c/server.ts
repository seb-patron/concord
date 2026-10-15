import { createServer as httpCreateServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { operations } from "./ops.ts";

type EventRecord = { seq: number; type: string; data: unknown };
type Client = { socket: import("node:net").Socket; lastSeq: number };
const HISTORY_LIMIT = 1000;

function wsFrame(value: string): Buffer {
  const payload = Buffer.from(value);
  const header = payload.length < 126 ? Buffer.from([0x81, payload.length])
    : payload.length < 65536 ? Buffer.from([0x81, 126, payload.length >> 8, payload.length & 255])
      : (() => { throw new Error("prototype frame too large"); })();
  return Buffer.concat([header, payload]);
}

function routeMatch(template: string, pathname: string): Record<string, string> | undefined {
  const names: string[] = [];
  const pattern = template.split("/").map((part) => {
    if (part.startsWith("{") && part.endsWith("}")) {
      names.push(part.slice(1, -1));
      return names.at(-1) === "path" ? "(.+)" : "([^/]+)";
    }
    return part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }).join("/");
  const match = new RegExp(`^${pattern}$`).exec(pathname);
  if (!match) return;
  return Object.fromEntries(names.map((name, index) => [name, decodeURIComponent(match[index + 1] ?? "")]));
}

export function createPrototypeServer(): { server: Server; listen: (port?: number) => Promise<number>; publish: (type: string, data: unknown) => EventRecord; metrics: () => Record<string, number>; close: () => Promise<void> } {
  let seq = 0;
  let requests = 0;
  let applicationTimersScheduled = 0;
  const events: EventRecord[] = [];
  const clients = new Set<Client>();
  const publishListeners = new Set<(event: EventRecord) => void>();
  const files = new Map([["README.md", "Concord v3 API spike fixture\n"]]);
  const changes = new Map<string, { repo: string; title: string; files: Record<string, string> }>();
  const readyIssues = [
    { id: "issue-17", title: "Add sequence based event replay", state: "ready" },
    { id: "issue-23", title: "Generate public API clients", state: "ready" },
  ];

  const publish = (type: string, data: unknown): EventRecord => {
    const event = { seq: ++seq, type, data };
    events.push(event);
    if (events.length > HISTORY_LIMIT) events.shift();
    const wire = JSON.stringify(event);
    for (const client of clients) {
      if (event.seq > client.lastSeq && !client.socket.destroyed) {
        const frame = wsFrame(wire);
        client.socket.write(frame);
        client.lastSeq = event.seq;
      }
    }
    for (const listener of publishListeners) listener(event);
    return event;
  };

  const server = httpCreateServer((req, res) => {
    requests++;
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method === "GET" && url.pathname === "/v1/events/sse") {
      const after = Number(url.searchParams.get("after") ?? "0");
      if (!Number.isSafeInteger(after) || after < 0) return sendJson(res, 400, { error: "after must be a non-negative sequence" });
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      for (const event of events) if (event.seq > after) res.write(`id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      const listener = (event: EventRecord) => res.write(`id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      publishListeners.add(listener);
      res.on("close", () => publishListeners.delete(listener));
      return;
    }
    for (const op of operations) {
      if (op.method !== req.method) continue;
      const params = routeMatch(op.path, url.pathname);
      if (!params) continue;
      if (op.name === "read_file") {
        const path = params.path;
        if (path.split("/").includes("..")) return sendJson(res, 400, { error: "invalid path" });
        const content = files.get(path);
        if (content === undefined) return sendJson(res, 404, { error: "file not found" });
        if (Buffer.byteLength(content) > op.readBudget.maximum) return sendJson(res, 413, { error: "read budget exceeded" });
        return sendJson(res, 200, { repo: params.repo, path, content, bytes: Buffer.byteLength(content) });
      }
      if (op.name === "list_ready_issues") {
        const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") ?? "100")));
        return sendJson(res, 200, { issues: readyIssues.slice(0, limit) });
      }
      if (op.name === "put_change") {
        const chunks: Buffer[] = [];
        let size = 0;
        req.on("data", (chunk: Buffer) => { size += chunk.length; if (size <= 1_048_576) chunks.push(chunk); });
        req.on("end", () => {
          if (size > 1_048_576) return sendJson(res, 413, { error: "request body exceeds 1 MiB prototype cap" });
          try {
            const input = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { title?: string; files?: Record<string, string> };
            if (!input.title || !input.files || typeof input.files !== "object" || Array.isArray(input.files)) return sendJson(res, 400, { error: "title and files are required" });
            const changeId = `change-${Date.now().toString(36)}-${(++changeCounter).toString(36)}`;
            changes.set(changeId, { repo: params.repo, title: input.title, files: input.files });
            publish("change.created", { repo: params.repo, changeId, title: input.title });
            return sendJson(res, 200, { changeId, status: "draft" });
          } catch { return sendJson(res, 400, { error: "invalid JSON" }); }
        });
        return;
      }
    }
    sendJson(res, 404, { error: "route not found" });
  });

  let changeCounter = 0;

  server.on("upgrade", (req: IncomingMessage, socket, head) => {
    requests++;
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/v1/events" || req.headers.upgrade?.toLowerCase() !== "websocket") { socket.destroy(); return; }
    const after = Number(url.searchParams.get("after") ?? "0");
    if (!Number.isSafeInteger(after) || after < 0 || after > seq) { socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n"); return; }
    const key = req.headers["sec-websocket-key"];
    if (typeof key !== "string") { socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n"); return; }
    const accept = createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
    const response = `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`;
    socket.write(response);
    const client = { socket, lastSeq: after };
    clients.add(client);
    socket.on("close", () => clients.delete(client));
    socket.on("error", () => clients.delete(client));
    socket.on("data", (data: Buffer) => {
      // Browser clients mask frames. The prototype only needs to acknowledge close frames.
      if (data.length > 0 && (data[0]! & 0x0f) === 0x8) socket.end(Buffer.from([0x88, 0x00]));
    });
    if (head.length) socket.unshift(head);
    if (events.length && after < events[0]!.seq - 1) {
      const gap = { seq, type: "resync_required", data: { oldestAvailable: events[0]!.seq } };
      const frame = wsFrame(JSON.stringify(gap));
      socket.write(frame);
      client.lastSeq = seq;
    } else {
      for (const event of events) if (event.seq > after) {
        const frame = wsFrame(JSON.stringify(event));
        socket.write(frame);
        client.lastSeq = event.seq;
      }
    }
  });

  // Instrumentation is intentionally application-level: no timer is scheduled for idle sockets.
  const sendJson = (res: ServerResponse, status: number, body: unknown) => {
    const payload = JSON.stringify(body);
    res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) });
    res.end(payload);
  };
  const listen = (port = 0) => new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.removeListener("error", reject);
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("unexpected listen address"));
      resolve(address.port);
    });
  });
  // These functions are attached for the benchmark without introducing traffic or a heartbeat.
  return {
    server,
    publish,
    metrics: () => ({ requests, timersScheduled: applicationTimersScheduled, connections: clients.size, latestSeq: seq,
      socketBytesRead: [...clients].reduce((sum, client) => sum + client.socket.bytesRead, 0),
      socketBytesWritten: [...clients].reduce((sum, client) => sum + client.socket.bytesWritten, 0) }),
    close: async () => new Promise<void>((resolve) => server.close(() => resolve())),
    listen,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const app = createPrototypeServer();
  const port = await app.listen(Number(process.env.PORT ?? 8787));
  console.log(`prototype listening on http://127.0.0.1:${port}`);
}
