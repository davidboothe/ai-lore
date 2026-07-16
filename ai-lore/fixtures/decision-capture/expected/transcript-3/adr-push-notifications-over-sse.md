---
id: adr-push-notifications-over-sse
title: Push live notifications over SSE instead of polling
date: 2026-07-01
stage: architect
affects_paths: [src/notifications/transport.ts]
supersedes: [adr-poll-for-notifications]
---

# Push live notifications over SSE instead of polling

## Context

A prior decision (adr-poll-for-notifications) chose short-interval polling for the notification feed to keep the first release simple. Recall surfaced that decision when the transport was revisited for the next release; polling is now producing a measurable load spike on the API every interval, and users still see up to a full interval of delay.

## Decision

Replace polling with an SSE push stream for live notifications, superseding adr-poll-for-notifications.

## Consequences

The client drops its interval timer in favor of a persistent EventSource connection; server infrastructure must keep one open connection per active client instead of handling discrete polling requests, so connection count now needs its own capacity planning.
