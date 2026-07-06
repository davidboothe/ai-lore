# Transcript 3: revisiting the notification transport

**Engineer:** We are picking the transport for the next release. Recall surfaced adr-poll-for-notifications, which chose short-interval polling for notifications at first release.

**Product:** Polling worked at launch, why revisit it?

**Engineer:** It is now producing a measurable load spike on the API every interval, and users still see up to a full interval of delay before a notification shows up. The real alternative is an SSE push stream, which we ruled out earlier only because polling was simpler to ship first.

**Product:** Switch to SSE push, then. Retire the polling decision.

**Engineer:** Confirmed, this supersedes adr-poll-for-notifications.

<!-- MANIFEST-START -->
CAPTURED id=adr-push-notifications-over-sse choice="Replace polling with an SSE push stream for live notifications, superseding adr-poll-for-notifications."
<!-- MANIFEST-END -->
