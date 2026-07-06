# Transcript 1: live notification transport

**Product:** How should we push new-notification events to a connected browser tab?

**Engineer:** Two real options: WebSockets, or Server-Sent Events. WebSockets is bidirectional but we never need the client to send anything back over this channel. SSE runs over plain HTTP, reconnects automatically via the browser's EventSource, and survives proxies that mishandle the WebSocket upgrade.

**Product:** Any downside?

**Engineer:** SSE is receive-only. If we ever need the client to push data back on the same channel we would need a second transport. For notifications that is fine, they only flow one way.

**Product:** Go with SSE then.

**Engineer:** Confirmed. Separately, the transport module just gets named notifications.ts, same as every other feature module in this codebase, so there is nothing to weigh there.

<!-- MANIFEST-START -->
CAPTURED id=adr-use-sse-not-websockets choice="Use SSE, not websockets, for the live notification transport."
<!-- MANIFEST-END -->
