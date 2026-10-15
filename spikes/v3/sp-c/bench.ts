import { createPrototypeServer } from "./server.ts";

const clientCount = 200;
const idleMs = 60_000;
async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms);
    })]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
const waitOpen = (socket: WebSocket) => new Promise<void>((resolve, reject) => {
  socket.addEventListener("open", () => resolve(), { once: true });
  socket.addEventListener("error", () => reject(new Error("WebSocket connection failed")), { once: true });
});
const waitClose = (socket: WebSocket) => new Promise<void>((resolve) => socket.addEventListener("close", () => resolve(), { once: true }));
const waitMessage = (socket: WebSocket) => new Promise<string>((resolve, reject) => {
  socket.addEventListener("message", (event) => resolve(String(event.data)), { once: true });
  socket.addEventListener("error", () => reject(new Error("WebSocket failed before replay")), { once: true });
});

async function main() {
  if (typeof WebSocket === "undefined") throw new Error("This benchmark requires Node's built-in WebSocket client");
  const app = createPrototypeServer();
  const port = await app.listen();
  globalThis.gc?.();
  const beforeHeap = process.memoryUsage().heapUsed;
  const sockets: WebSocket[] = [];
  let resumed: WebSocket | undefined;
  try {
  for (let start = 0; start < clientCount; start += 20) {
    const batch = Array.from({ length: Math.min(20, clientCount - start) }, () => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}/v1/events?after=0`);
      sockets.push(socket);
      return waitOpen(socket);
    });
    await withTimeout(Promise.all(batch), 10_000);
  }
  if (app.metrics().connections !== clientCount) throw new Error(`expected ${clientCount} connections; got ${app.metrics().connections}`);
  globalThis.gc?.();
  const connectedHeap = process.memoryUsage().heapUsed;
  const startMetrics = app.metrics();
  const startSocketBytesRead = startMetrics.socketBytesRead;
  const startSocketBytesWritten = startMetrics.socketBytesWritten;
  const idleStarted = Date.now();
  await new Promise((resolve) => setTimeout(resolve, idleMs));
  const elapsedMs = Date.now() - idleStarted;
  const idleMetrics = app.metrics();
  const idleBytesRead = idleMetrics.socketBytesRead - startSocketBytesRead;
  const idleBytesWritten = idleMetrics.socketBytesWritten - startSocketBytesWritten;
  const idleRequests = idleMetrics.requests - startMetrics.requests;
  const idleTimers = idleMetrics.timersScheduled - startMetrics.timersScheduled;

  const resumeBase = idleMetrics.latestSeq;
  const disconnected = sockets[0]!;
  const closed = waitClose(disconnected);
  disconnected.close();
  await withTimeout(closed, 5_000);
  const expected = app.publish("spike.resume_probe", { marker: "event-emitted-during-disconnect" });
  resumed = new WebSocket(`ws://127.0.0.1:${port}/v1/events?after=${resumeBase}`);
  const receivedPromise = waitMessage(resumed);
  await withTimeout(waitOpen(resumed), 5_000);
  const received = JSON.parse(await withTimeout(receivedPromise, 5_000)) as { seq: number; type: string; data: { marker?: string } };
  const resumeCorrect = received.seq === expected.seq && received.type === expected.type && received.data.marker === "event-emitted-during-disconnect";
  if (!resumeCorrect) throw new Error(`resume mismatch expected=${JSON.stringify(expected)} got=${JSON.stringify(received)}`);

  console.log(`clients=${clientCount}`);
  console.log(`idle_duration_ms=${elapsedMs}`);
  console.log(`idle_http_requests=${idleRequests}`);
  console.log(`idle_socket_bytes_read=${idleBytesRead}`);
  console.log(`idle_socket_bytes_written=${idleBytesWritten}`);
  console.log(`idle_server_timers_scheduled=${idleTimers}`);
  console.log(`heap_delta_bytes=${connectedHeap - beforeHeap}`);
  console.log(`heap_delta_bytes_per_connection=${Math.round((connectedHeap - beforeHeap) / clientCount)}`);
  console.log(`resume_expected_seq=${expected.seq}`);
  console.log(`resume_received_seq=${received.seq}`);
  console.log(`resume_correct=${resumeCorrect}`);
  console.log(`requests_total_including_upgrades=${app.metrics().requests}`);

  } finally {
    for (const socket of [...sockets, ...(resumed ? [resumed] : [])]) {
      if (socket.readyState === WebSocket.OPEN) socket.close();
    }
    await app.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
