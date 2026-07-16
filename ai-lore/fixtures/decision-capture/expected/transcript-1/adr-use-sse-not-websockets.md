---
id: adr-use-sse-not-websockets
title: Use SSE, not websockets, for live notifications
date: 2026-07-01
stage: architect
affects_paths: [src/notifications/transport.ts, src/notifications/server.ts]
supersedes: []
---

# Use SSE, not websockets, for live notifications

## Context

The notifications feature needs to push events from the server to a connected browser tab in near-real-time. Two transports were considered: WebSockets (bidirectional, persistent connection) and Server-Sent Events, SSE (unidirectional, plain HTTP). Clients never need to send data back over this channel, only receive it.

## Decision

Use SSE for the live notification stream. It runs over plain HTTP, so it survives corporate proxies and load balancers that mishandle the WebSocket upgrade, and the browser's built-in EventSource reconnects automatically on drop, removing the need for hand-rolled reconnect logic.

## Consequences

Any future feature that needs the client to push data back to the server over the same channel will require a second transport or a fallback request-response call; SSE is receive-only by design. This constraint is accepted because notifications are read-only from the client's perspective.
