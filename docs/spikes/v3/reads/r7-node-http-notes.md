# HTTP | Node.js v24.22.0 Documentation
URL: https://nodejs.org/download/release/latest-v24.x/docs/api/http.html
Fetched: 2026-10-15 20:30:45 UTC; method: curl -L --fail --silent --show-error 'https://nodejs.org/download/release/latest-v24.x/docs/api/http.html' -o "$DELEGATE_SCRATCH_DIR/r7-node-http.html"
Raw SHA-256: 1524a18767225cea6a7cc84e713ddab00552650bd8825974fde8fa6c997cf0aa
Extracted words: 18623 (command: python3 -c 'import os; from pathlib import Path; p=Path(os.environ["DELEGATE_SCRATCH_DIR"])/"r7-node-http.txt"; print(sum(len((line.split("] ",1)[1] if "] " in line else line).split()) for line in p.read_text().splitlines()))')
Read status: read in full

## Sections
1. **HTTP** - The module provides low-level HTTP framing and streaming for clients and servers. It leaves application interpretation of headers and bodies to callers.
2. **Class: http.Agent** - Agent queues requests and manages connection reuse, pooling, scheduling, proxies, and socket limits. These are transport resource controls.
3. **Response ordering with connection reuse** - HTTP/1.1 keep-alive pairs messages by connection order. Separate Agents or disabled reuse provide per-request isolation.
4. **new Agent([options])** - Construction configures reuse, scheduling, limits, and proxy defaults. These settings shape connection capacity.
5. **agent.createConnection(options[, callback])** - Creates the Duplex used for HTTP requests; custom Agents may return it synchronously or deliver it through a callback. Socket creation errors are passed to that callback.
6. **agent.keepSocketAlive(socket)** - Controls whether a completed socket is retained for reuse; the default enables TCP keep-alive and unreferences it. An override can reject persistence and force destruction.
7. **agent.reuseSocket(socket, request)** - Runs when a pooled socket is attached to a new request. The default references the socket again, and custom Agents may override this behavior.
8. **agent.destroy()** - Destroys sockets managed by the Agent, including those currently in use. Explicit shutdown releases keep-alive resources.
9. **agent.freeSockets** - Lists idle sockets awaiting reuse and is internal state that callers must not modify. Timed-out free sockets are removed automatically.
10. **agent.getName([options])** - Builds the key used to decide whether requests can share a connection. HTTP keys include host, port, local address, and optionally address family.
11. **agent.maxFreeSockets** - Limits idle pooled sockets per host when keep-alive is enabled; the documented default is 256. This bounds retained idle resources.
12. **agent.maxSockets** - Limits simultaneous sockets per origin; excess requests wait in the Agent queue. The documented default is Infinity.
13. **agent.maxTotalSockets** - Limits simultaneous sockets across all origins. It complements the per-origin maxSockets setting.
14. **agent.requests** - Contains requests waiting for a socket and is internal Agent state. The documentation says not to modify it.
15. **agent.sockets** - Contains sockets currently in use and is internal Agent state. The documentation says not to modify it.
16. **Class: http.ClientRequest** - ClientRequest is a writable request stream with a separate response lifecycle. Callers must consume responses and distinguish sent from completed bytes.
17. **Event: 'abort'** - Signals cancellation; remaining response data may be dropped. Timing and payload are part of the contract.
18. **Event: 'close'** - Marks message completion or premature termination. Timing and payload are part of the contract.
19. **Event: 'connect'** - Transfers a CONNECT tunnel to raw socket handling. Timing and payload are part of the contract.
20. **Event: 'continue'** - Indicates 100 Continue permits sending the body. Timing and payload are part of the contract.
21. **Event: 'finish'** - Means data reached the operating system, not necessarily the remote peer. Timing and payload are part of the contract.
22. **Event: 'information'** - Carries interim 1xx responses; 101 uses upgrade. Timing and payload are part of the contract.
23. **Event: 'response'** - Delivers the response after headers arrive; consume its stream. Timing and payload are part of the contract.
24. **Event: 'socket'** - Exposes the assigned connection stream. Timing and payload are part of the contract.
25. **Event: 'timeout'** - Reports inactivity; it does not itself cancel the operation. Timing and payload are part of the contract.
26. **Event: 'upgrade'** - Hands the connection to another protocol. Timing and payload are part of the contract.
27. **request.abort()** - Marks the request as aborting, drops remaining response data, and destroys its socket. The event is emitted only on the first call.
28. **request.aborted** - Boolean state indicating the request was aborted; this property is deprecated. Use the message lifecycle events instead.
29. **request.connection** - Alias for request.socket, the underlying Duplex. The HTTP parser owns its reads, so it does not emit readable events normally.
30. **request.cork()** - Applies the writable stream cork operation to batch output. Pair it with uncork() when the batch is ready.
31. **request.end([data[, encoding]][, callback])** - Ends a message but does not prove all bytes have flushed. Preserve its protocol timing and error semantics.
32. **request.destroy([error])** - Terminates a message and may destroy its socket. Preserve its protocol timing and error semantics.
33. **request.destroyed** - Becomes true after request.destroy() is called. It records teardown, not successful delivery.
34. **request.finished** - Becomes true after request.end() is called, including automatic end by http.get(). It does not mean bytes have flushed.
35. **request.flushHeaders()** - Sends buffered headers early, bypassing packet coalescing. Preserve its protocol timing and error semantics.
36. **request.getHeader(name)** - Reads a queued outgoing header case-insensitively and returns the value in its original type. Arrays can be returned for repeated values.
37. **request.getHeaderNames()** - Lists unique outgoing header names in lowercase. It reflects headers currently queued for sending.
38. **request.getHeaders()** - Returns a shallow copy of outgoing headers with lowercase names. The returned object has a null prototype, and nested array values remain shared.
39. **request.getRawHeaderNames()** - Lists unique outgoing names using the exact casing set by the caller. Use it when wire-facing casing matters.
40. **request.hasHeader(name)** - Checks whether a queued header exists using case-insensitive matching. It does not inspect headers already sent.
41. **request.maxHeadersCount** - Limits the maximum number of response headers, defaulting to 1000. Set it to zero for no limit.
42. **request.path** - Exposes the request target path. Query parameters belong in this value when required.
43. **request.method** - Exposes the request method string. It describes the protocol request, not application authorization.
44. **request.host** - Exposes the request host value. Validate any host-derived routing decisions at the application boundary.
45. **request.protocol** - Exposes the protocol used for the request. It is request metadata, not a trust decision.
46. **request.removeHeader(name)** - Removes a header that is queued for transmission. Header matching is case-insensitive.
47. **request.reusedSocket** - Indicates the Agent assigned a previously used socket. The docs show using it to decide whether an ECONNRESET retry is appropriate.
48. **request.setHeader(name, value)** - Sets or replaces a header before sending; values are validated. Preserve its protocol timing and error semantics.
49. **request.setNoDelay([noDelay])** - Applies socket.setNoDelay() after a socket is assigned and connected. It controls Nagle's algorithm for that request connection.
50. **request.setSocketKeepAlive([enable][, initialDelay])** - Applies socket.setKeepAlive() after connection. The options control TCP keep-alive and its initial delay.
51. **request.setTimeout(timeout[, callback])** - Sets an inactivity timeout after the socket connects and may register a timeout callback. A timeout event does not itself abort the request.
52. **request.socket** - References the underlying Duplex, which may outlive this message. Preserve its protocol timing and error semantics.
53. **request.uncork()** - Releases writable stream corking and allows buffered output to proceed. It complements request.cork().
54. **request.writableEnded** - Shows end() was called, not that data flushed. Preserve its protocol timing and error semantics.
55. **request.writableFinished** - Shows output flushed just before finish. Preserve its protocol timing and error semantics.
56. **request.write(chunk[, encoding][, callback])** - Streams body chunks and reports backpressure; wait for drain when needed. Preserve its protocol timing and error semantics.
57. **Class: http.Server** - Server accepts connections and exposes request, parser error, timeout, tunnel, and upgrade behavior. Options bound parsing and connection lifecycle.
58. **Event: 'checkContinue'** - Lets the server decide whether the body may be sent. Timing and payload are part of the contract.
59. **Event: 'checkExpectation'** - Handles unsupported Expect values before dispatch. Timing and payload are part of the contract.
60. **Event: 'clientError'** - Surfaces parser errors without request/response objects; listener closes the socket. Timing and payload are part of the contract.
61. **Event: 'close'** - Marks message completion or premature termination. Timing and payload are part of the contract.
62. **Event: 'connect'** - Transfers a CONNECT tunnel to raw socket handling. Timing and payload are part of the contract.
63. **Event: 'connection'** - Reports a new connection before request handling. Timing and payload are part of the contract.
64. **Event: 'dropRequest'** - Reports excess requests; the client receives 503. Timing and payload are part of the contract.
65. **Event: 'request'** - Delivers each parsed request and response pair. Timing and payload are part of the contract.
66. **Event: 'upgrade'** - Hands the connection to another protocol. Timing and payload are part of the contract.
67. **server.close([callback])** - Stops accepting new connections and closes connections that are idle between requests. Its callback runs after the server closes.
68. **server.closeAllConnections()** - Forcefully closes established HTTP(S) connections, including active ones, but leaves upgraded protocols alone. Call after close() to avoid races with new connections.
69. **server.closeIdleConnections()** - Closes connections not handling a request or response. It is mainly useful for compatibility with Node versions before automatic idle cleanup.
70. **server.headersTimeout** - Bounds time to receive complete headers; expiry returns 408 and closes the connection. A nonzero value protects deployments without a reverse proxy.
71. **server.listen()** - Starts accepting HTTP connections using the net.Server listen behavior. The returned server can be managed through the usual Server lifecycle.
72. **server.listening** - Indicates whether the server is listening for connections. It is a read-only lifecycle state.
73. **server.maxHeadersCount** - Limits incoming header count, defaulting to 1000. Zero removes the limit.
74. **server.requestTimeout** - Bounds time to receive the full request; expiry returns 408 before request dispatch. The current documented default is 300 seconds.
75. **server.setTimeout([msecs][, callback])** - Sets socket inactivity timeout and emits the server timeout event. If a handler is installed, the application must handle timed-out sockets.
76. **server.maxRequestsPerSocket** - Caps requests served over one keep-alive socket; zero disables the cap. Later requests receive 503 after the limit is reached.
77. **server.timeout** - Sets inactivity time allowed on incoming sockets, defaulting to no timeout. Changes apply only to newly accepted connections.
78. **server.keepAliveTimeout** - Sets idle time after a response before destroying the connection, defaulting to five seconds. It combines with keepAliveTimeoutBuffer for the internal socket timeout.
79. **server.keepAliveTimeoutBuffer** - Adds an internal second to the advertised keep-alive timeout by default. The buffer reduces resets and applies to new connections.
80. **server[Symbol.asyncDispose]()** - Calls server.close() and returns a promise fulfilled after closure. It provides async-disposal integration for server lifecycle management.
81. **Class: http.ServerResponse** - ServerResponse is the writable response stream for status, headers, trailers, and body. Flushing does not prove client receipt.
82. **Event: 'close'** - Marks message completion or premature termination. Timing and payload are part of the contract.
83. **Event: 'finish'** - Means data reached the operating system, not necessarily the remote peer. Timing and payload are part of the contract.
84. **response.addTrailers(headers)** - Adds trailing fields only when chunked encoding is used and the Trailer header names them. Invalid field names or values throw TypeError.
85. **response.connection** - Alias for response.socket, the underlying Duplex. The parser owns its reads, and the reference is nulled after response.end().
86. **response.cork()** - Applies writable stream corking to batch response output. Pair it with uncork() to resume writes.
87. **response.end([data[, encoding]][, callback])** - Ends a message but does not prove all bytes have flushed. Preserve its protocol timing and error semantics.
88. **response.finished** - Becomes true after response.end() is called. It does not mean the response has flushed to the operating system.
89. **response.flushHeaders()** - Sends buffered headers early, bypassing packet coalescing. Preserve its protocol timing and error semantics.
90. **response.getHeader(name)** - Reads a queued header case-insensitively and returns the value in its stored type. It only sees headers not yet sent.
91. **response.getHeaderNames()** - Lists unique outgoing header names in lowercase. It reflects the current queued headers.
92. **response.getHeaders()** - Returns a shallow copy of queued headers with lowercase names. Its null prototype means standard Object methods are unavailable.
93. **response.hasHeader(name)** - Checks whether a queued outgoing header exists using case-insensitive matching. It does not inspect transmitted headers.
94. **response.headersSent** - Read-only flag indicating whether response headers have been sent. It distinguishes mutable header setup from a committed response.
95. **response.removeHeader(name)** - Removes a queued header before implicit transmission. It cannot retract headers already sent.
96. **response.req** - References the IncomingMessage that produced this response. It links response handling to its originating request.
97. **response.sendDate** - Automatically emits Date when true and no Date header was set; it defaults to true. The documentation says disable it only for testing.
98. **response.setHeader(name, value)** - Sets or replaces a header before sending; values are validated. Preserve its protocol timing and error semantics.
99. **response.setTimeout(msecs[, callback])** - Sets the underlying socket timeout and optionally listens for timeout. If any timeout handler is installed, timed-out sockets must be handled explicitly.
100. **response.socket** - References the underlying Duplex and is nulled after response.end(). The parser owns its reads during HTTP handling.
101. **response.statusCode** - Defaults to 200 and controls the status sent with implicit headers. After transmission it reports the sent code.
102. **response.statusMessage** - Sets the reason phrase for implicit headers, otherwise the standard phrase is used. After transmission it reports the sent phrase.
103. **response.strictContentLength** - Checks body byte count against Content-Length. Preserve its protocol timing and error semantics.
104. **response.uncork()** - Releases writable stream corking and allows buffered output to proceed. It complements response.cork().
105. **response.writableEnded** - Shows end() was called, not that data flushed. Preserve its protocol timing and error semantics.
106. **response.writableFinished** - Shows output flushed just before finish. Preserve its protocol timing and error semantics.
107. **response.write(chunk[, encoding][, callback])** - Streams body chunks and reports backpressure; wait for drain when needed. Preserve its protocol timing and error semantics.
108. **response.writeContinue()** - Sends interim 100 Continue. Preserve its protocol timing and error semantics.
109. **response.writeEarlyHints(hints[, callback])** - Sends interim 103 Early Hints. Preserve its protocol timing and error semantics.
110. **response.writeHead(statusCode[, statusMessage][, headers])** - Sends status and headers once, with explicit values taking precedence. Preserve its protocol timing and error semantics.
111. **response.writeInformation(statusCode[, headers][, callback])** - Sends an interim 1xx response before final headers. Preserve its protocol timing and error semantics.
112. **response.writeProcessing()** - Sends interim 102 Processing. Preserve its protocol timing and error semantics.
113. **Class: http.IncomingMessage** - IncomingMessage is a readable parsed message distinct from its reusable socket. It exposes message metadata and streamed content.
114. **Event: 'aborted'** - Indicates that the incoming message was aborted. Timing and payload are part of the contract.
115. **Event: 'close'** - Marks message completion or premature termination. Timing and payload are part of the contract.
116. **message.aborted** - Indicates that the incoming message was aborted. Use it with the aborted/close lifecycle events to detect incomplete delivery.
117. **message.complete** - Indicates whether the complete HTTP message was received and parsed. It helps distinguish a clean end from a truncated connection.
118. **message.connection** - Alias for message.socket, the connection Duplex. The incoming message remains a separate readable stream.
119. **message.destroy([error])** - Terminates a message and may destroy its socket. Preserve its protocol timing and error semantics.
120. **message.headers** - Exposes parsed headers with duplicate joining rules. Preserve its protocol timing and error semantics.
121. **message.headersDistinct** - Exposes header values as arrays without joining duplicates. Preserve its protocol timing and error semantics.
122. **message.httpVersion** - Reports the peer's HTTP version as major.minor text. The major and minor components are also exposed separately.
123. **message.method** - Exposes the method for a server-side request and is read-only. It is absent as a meaningful request method on client responses.
124. **message.rawHeaders** - Preserves received names, casing, order, and duplicates. Preserve its protocol timing and error semantics.
125. **message.rawTrailers** - Preserves received trailers, populated at end. Preserve its protocol timing and error semantics.
126. **message.setTimeout(msecs[, callback])** - Sets a timeout on the message socket and optionally registers a callback. Timeout notification does not itself cancel message processing.
127. **message.signal** - Provides cancellation for premature termination and downstream work. Preserve its protocol timing and error semantics.
128. **message.socket** - References the underlying Duplex, which may outlive this message. Preserve its protocol timing and error semantics.
129. **message.statusCode** - Exposes the three-digit code only for a response received by ClientRequest. It is protocol response metadata.
130. **message.statusMessage** - Exposes the reason phrase only for a response received by ClientRequest. It may be absent or implementation-specific.
131. **message.trailers** - Exposes parsed trailers after completion. Preserve its protocol timing and error semantics.
132. **message.trailersDistinct** - Exposes trailers without duplicate joining. Preserve its protocol timing and error semantics.
133. **message.url** - Contains the request target, not a validated absolute URL. Preserve its protocol timing and error semantics.
134. **Class: http.OutgoingMessage** - OutgoingMessage is the shared write-only base for requests and responses. It defines header, streaming, and completion behavior.
135. **Event: 'drain'** - Signals writable backpressure has cleared. Timing and payload are part of the contract.
136. **Event: 'finish'** - Means data reached the operating system, not necessarily the remote peer. Timing and payload are part of the contract.
137. **Event: 'prefinish'** - End processing is done, though output may remain buffered. Timing and payload are part of the contract.
138. **outgoingMessage.addTrailers(headers)** - Adds trailing headers only for chunked messages and requires a Trailer declaration. Invalid names and values throw TypeError.
139. **outgoingMessage.appendHeader(name, value)** - Adds another value, or behaves like setHeader when no value exists. uniqueHeaders can cause repeated values to be joined with semicolons.
140. **outgoingMessage.connection** - Alias for outgoingMessage.socket. It exposes the underlying writable connection stream.
141. **outgoingMessage.cork()** - Batches output using the writable stream cork mechanism. Use uncork() when writes should resume.
142. **outgoingMessage.destroy([error])** - Terminates a message and may destroy its socket. Preserve its protocol timing and error semantics.
143. **outgoingMessage.end(chunk[, encoding][, callback])** - Ends a message but does not prove all bytes have flushed. Preserve its protocol timing and error semantics.
144. **outgoingMessage.flushHeaders()** - Sends buffered headers early, bypassing packet coalescing. Preserve its protocol timing and error semantics.
145. **outgoingMessage.getHeader(name)** - Reads a queued header value case-insensitively, returning undefined when absent. The return value may be a number, string, or string array.
146. **outgoingMessage.getHeaderNames()** - Lists unique queued header names in lowercase. It does not include duplicate occurrences.
147. **outgoingMessage.getHeaders()** - Returns a shallow copy of queued headers with lowercase names. Its null prototype means standard Object methods are unavailable.
148. **outgoingMessage.hasHeader(name)** - Checks for a queued header using case-insensitive matching. This query applies before transmission.
149. **outgoingMessage.headersSent** - Read-only state showing whether headers were sent. After this point header mutations cannot affect the wire message.
150. **outgoingMessage.pipe()** - Throws because outgoing messages are write-only. Preserve its protocol timing and error semantics.
151. **outgoingMessage.removeHeader(name)** - Removes a header queued for implicit sending. It cannot alter data already transmitted.
152. **outgoingMessage.setHeader(name, value)** - Sets or replaces a header before sending; values are validated. Preserve its protocol timing and error semantics.
153. **outgoingMessage.setHeaders(headers)** - Sets multiple values from a Headers or Map instance, replacing existing names. Later writeHead values take precedence.
154. **outgoingMessage.setTimeout(msecs[, callback])** - Applies a socket timeout after a connected socket is associated with the message. Its optional callback handles the timeout event.
155. **outgoingMessage.socket** - References the underlying Duplex, which may outlive this message. Preserve its protocol timing and error semantics.
156. **outgoingMessage.uncork()** - Releases writable buffering and allows queued writes to proceed. It complements cork().
157. **outgoingMessage.writableCorked** - Reports how many times cork() was called without a matching uncork(). It exposes writable batching state.
158. **outgoingMessage.writableEnded** - Shows end() was called, not that data flushed. Preserve its protocol timing and error semantics.
159. **outgoingMessage.writableFinished** - Shows output flushed just before finish. Preserve its protocol timing and error semantics.
160. **outgoingMessage.writableHighWaterMark** - Reports the socket's high-water mark when assigned, otherwise the writable default of 16384 bytes. It is the threshold that informs backpressure.
161. **outgoingMessage.writableLength** - Reports the number of output bytes currently buffered. It helps callers observe queued writes.
162. **outgoingMessage.writableObjectMode** - Is always false for HTTP outgoing messages. Writes are byte-oriented rather than object-oriented.
163. **outgoingMessage.write(chunk[, encoding][, callback])** - Streams body chunks and reports backpressure; wait for drain when needed. Preserve its protocol timing and error semantics.
164. **http.METHODS** - Lists methods supported by the parser. Parser support does not define authorization.
165. **http.STATUS_CODES** - Maps standard codes to descriptions. These constants do not define business outcomes.
166. **http.createServer([options][, requestListener])** - Creates a configurable server with parser, timeout, upgrade, and stream options. It can register a request listener.
167. **http.get(options[, callback])** - Convenience GET ends the request automatically. Its response stream must still be consumed.
168. **http.get(url[, options][, callback])** - Convenience GET ends the request automatically. Its response stream must still be consumed.
169. **http.globalAgent** - Provides the default Agent with keep-alive and a five-second timeout. Explicit Agents permit caller control.
170. **http.maxHeaderSize** - Exposes the default header-size limit, overridable per server or request. It bounds parser resources.
171. **http.request(options[, callback])** - Creates a writable request with method, headers, Agent, signal, and connection options. Call end() and handle errors separately.
172. **http.request(url[, options][, callback])** - Creates a writable request with method, headers, Agent, signal, and connection options. Call end() and handle errors separately.
173. **http.validateHeaderName(name[, label])** - Performs low-level validation and throws typed errors. Ordinary HTTP APIs validate automatically.
174. **http.validateHeaderValue(name, value)** - Performs low-level validation and throws typed errors. Ordinary HTTP APIs validate automatically.
175. **http.setMaxIdleHTTPParsers(max)** - Sets the idle parser limit. This caps retained process resources.
176. **http.setGlobalProxyFromEnv([proxyEnv])** - Reconfigures global proxy settings and returns a restore function. Configure before requests start.
177. **Class: WebSocket** - This is a browser-compatible WebSocket implementation. It is distinct from ordinary HTTP request handling.
178. **Built-in Proxy Support** - Agents can route outbound HTTP(S) through configured proxies and bypass destinations. Proxying does not provide anonymity.
179. **Proxy security considerations** - Proxying is routing, not anonymity; proxies may observe metadata and content. Configure only trusted endpoints.
180. **Proxy URL Format** - Documents HTTP and HTTPS proxy URLs, optionally with credentials. Syntax does not establish trust.
181. **NO_PROXY Format** - Defines host, suffix, wildcard, IP, range, and port bypass patterns. Matching controls proxy bypass.
182. **Example** - Shows environment and runtime proxy activation and custom Agents. These are transport configuration examples.

## What it means for Concord v3
Node's HTTP API is a transport layer: it streams bytes, parses message framing, and leaves application interpretation to callers. This supports the draft's described single operation table for HTTP, CLI, and MCP: adapters should dispatch the same operation semantics while validation, authorization, and domain rules remain in Concord's server-side operation layer. Stream completion, backpressure, and request abort signals matter for issue runs that may be cancelled or outlive a client connection.

Server upgrade events hand connections to raw socket handling. This agrees with the draft's events-over-WebSocket direction at the protocol boundary; delivery still needs explicit framing, authentication, replay, and failure semantics. Agent pooling, timeouts, and proxy behavior are operational details and do not imply file or symbol leases. This page does not establish Concord's Git workflow, presence claims, or server-side landing policy; those remain product decisions.

| URL | Extracted words | Read status |
| --- | ---: | --- |
| https://nodejs.org/download/release/latest-v24.x/docs/api/http.html | 18623 | read in full |
