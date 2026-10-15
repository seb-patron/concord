# SP-C: realtime events and operation table

**Date:** 2026-10-15  
**Decision context:** Concord v3, with [D-POLL-SPIKE](../../decisions.md) and [D-PUSH-AFTER-SUBMISSION](../../decisions.md) as the recorded direction to spike live updates and move UI/checker updates to WebSocket push after submission.

## Result

The local Node 26.7.0 run held 200 idle WebSocket connections for 60.001 seconds. During that interval it observed **0 additional HTTP requests, 0 bytes read, 0 bytes written, and 0 application timers scheduled**. The heap delta for the benchmark process was 9,390,064 bytes, or **46,950 bytes per open client connection**. That heap figure includes both the Node server and the in-process WebSocket clients; it is a rough prototype measurement, not a server-only or production capacity estimate.

After forcibly closing one connection, the benchmark published an event while it was disconnected, reconnected with `after=0`, and received sequence 1 with the original marker. Resume correctness was true. There were 201 HTTP requests in total: 200 initial WebSocket upgrades and one reconnect. The event was held in a bounded in-memory history for this run.

The prototype is a single-process fixture. The three HTTP handlers use in-memory sample data; they do not read a real repository, persist a changeset, authorize credentials, or query a real issue store. The Node server implements the small WebSocket framing surface needed by this spike without a package. It binds only to `127.0.0.1`. The idle timer counter is instrumentation for application timers created by the prototype; it does not count Node runtime internals or the benchmark's own 60-second wait.

## Channel recommendation

Use **hibernatable WebSockets on the repository Durable Object as the primary event channel**, with a durable, monotonically sequenced event log. Clients connect with `after=seq`; on reconnect the server replays later events. Derive presence from current accepted connection state and remove it on close. Do not schedule heartbeat or polling timers for idle clients. The prototype's idle result supports the zero-traffic design for this Node fixture; it does not itself establish Cloudflare billing or production cost.

Cloudflare's Durable Object documentation says eligible hibernating WebSocket servers keep clients connected while the object is out of memory and do not accrue billable duration during hibernation. The connection still requires a request to establish; Cloudflare's pricing page also applies a 20:1 billing ratio to incoming WebSocket messages and says outgoing WebSocket messages are not charged as requests. Thus the idle cost target is plausible when the object can hibernate, but connection setup/reconnects and delivered inbound messages still have request cost. Avoid alarms, scheduled callbacks, unfinished I/O, and the standard WebSocket API where they prevent hibernation.

Provide **SSE as a compatibility fallback** for clients that only need server-to-client updates. SSE is one-way and uses ordinary HTTP text streams; its standard reconnection and event IDs are a good fit for replay cursors. The prototype exposes `/v1/events/sse?after=seq`; production should map `Last-Event-ID` to the same durable cursor and bound replay history. This keeps the primary channel bidirectional while making a simple read-only fallback available.

The Node prototype shows that Node's built-in HTTP server exposes raw upgrade sockets, so a WebSocket server needs protocol handling or an installed implementation. The measured 46,969 bytes/client includes Node's built-in WebSocket client overhead and must not be compared to a server-only footprint. Bun documents a built-in `Bun.serve()` WebSocket server and shared handlers, which could reduce implementation surface for a self-hosted runtime. Neither Node nor Bun's production idle infrastructure cost was measured here. An always-resident process retains its connection state and process allocation while idle; the exact cost depends on deployment and is **UNVERIFIED** for Concord. No Node-vs-Bun throughput or memory comparison was run.

## MCP implications

The MCP 2025-11-25 standard transport is Streamable HTTP, not this prototype's WebSocket endpoint. It permits an SSE stream for server messages, including server-to-client requests and notifications. A server that changes its available tool list can advertise `tools.listChanged` and send `notifications/tools/list_changed`; that notification is specifically about tool-list changes, not a general repository event feed.

MCP also describes long-running requests over SSE: a stream can carry related server messages before the eventual JSON-RPC response; disconnect does not mean cancellation; clients explicitly send `CancelledNotification` to cancel. A server may make a stream resumable with event IDs, and clients resume via GET and `Last-Event-ID`. Concord should keep the event channel's cursor semantics aligned with that behavior in its MCP adapter. WebSocket support would be a Concord-specific transport extension; MCP clients that only implement standard transports still need Streamable HTTP/SSE.

## Operation table recommendation

Keep one declarative operation table as the source of truth for HTTP routing, OpenAPI 3.1, CLI help, and MCP `tools/list`. Each entry should own its name, method/path, input and output JSON Schemas, required authorization scope, and explicit read budget. Generate all public descriptions from that table and enforce the scope and budget in the runtime handler too; generated metadata alone is not enforcement.

`spikes/v3/sp-c/ops.ts` defines `read_file`, `put_change`, and `list_ready_issues`. `gen.ts` prints the OpenAPI document, CLI help, and a JSON-RPC-shaped MCP tools/list result. `server.ts` matches the same method/path entries and serves the three routes plus WebSocket and SSE event streams. The fixtures validate that one schema source can feed these surfaces without another npm dependency. This is a prototype recommendation, not evidence that the production Concord authorization or API shape is settled.

## Reproduction and measured output

Run from the repository root with Node 26 (the repository declares Node >=22):

```sh
node spikes/v3/sp-c/gen.ts
node spikes/v3/sp-c/server.ts
node --expose-gc spikes/v3/sp-c/bench.ts
```

The benchmark opens the 200 clients in batches of 20 to avoid a burst of concurrent handshakes, then leaves all open and silent for 60 seconds. The captured generated documents and benchmark output are in [`spikes/v3/sp-c/output.txt`](../../../spikes/v3/sp-c/output.txt).

## Unverified items

- **UNVERIFIED:** production Cloudflare Durable Object idle billing for Concord's eventual implementation; the recommendation follows the documented hibernation billing rules, but this prototype was not deployed to Cloudflare.
- **UNVERIFIED:** production memory per server-side connection, max connections, throughput, and Node/Bun hosting cost; the local heap number includes benchmark clients and only 200 sockets.
- **UNVERIFIED:** durable replay behavior across process restart, event retention policy, authentication/authorization, and real repository/issue/changeset integration.
- **UNVERIFIED:** the supplied context's Cloudflare Artifacts operation pricing and read-only write limitation were not re-measured in this spike.

## Primary sources

- Cloudflare Durable Objects pricing, https://developers.cloudflare.com/durable-objects/platform/pricing/ — read the relevant section (compute billing, WebSocket request/message billing).
- Cloudflare Durable Objects WebSockets, https://developers.cloudflare.com/durable-objects/best-practices/websockets/ — read the relevant sections (hibernation, timers, attachments, standard API).
- Node.js HTTP API, https://nodejs.org/download/release/latest-v24.x/docs/api/http.html — read the relevant section (`upgrade` event and raw socket handling).
- Bun WebSockets, https://bun.sh/docs/runtime/http/websockets — read the relevant sections (server setup, shared handlers, pub/sub).
- WHATWG HTML Standard, https://html.spec.whatwg.org/multipage/server-sent-events.html — read the relevant section (SSE event stream and reconnection).
- MCP Transports, https://modelcontextprotocol.io/specification/2025-11-25/basic/transports — read the relevant sections (Streamable HTTP, server messages, long-running requests, resumability).
- MCP Tools, https://modelcontextprotocol.io/specification/2025-11-25/server/tools — read the relevant sections (`tools/list`, output schemas, and `notifications/tools/list_changed`).
