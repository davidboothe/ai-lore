---
id: adr-fixture-001
title: Store notification preferences in a dedicated table
date: 2026-07-01
stage: plan-waves
affects_paths: [db/migrations, src/notifications/preferences.ts]
supersedes: []
---

# Store notification preferences in a dedicated table

## Context

Notification preferences could be added as new columns on the existing users table, or split into a dedicated notification_preferences table keyed by user id and channel. The team weighed schema simplicity against forward compatibility with per-channel preferences (email, push, in-app) already on the near-term roadmap.

## Decision

Store notification preferences in a dedicated notification_preferences table, one row per user per channel, rather than adding columns to users.

## Consequences

Every read of a user's preferences now requires a join instead of a single-table lookup, and the notification-sending path must handle the case where no preference row exists yet (default to opted-in). This is accepted because it avoids a users-table migration each time a new notification channel ships.
