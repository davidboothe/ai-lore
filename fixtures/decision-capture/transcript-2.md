# Transcript 2: notification preferences storage and file naming

**Engineer:** I am adding a preferences module for notifications. I will name the file notifications.ts inside src/notifications, matching the naming used by every other module. Nothing to debate there.

**Product:** Fine. Where do we store the preference values themselves?

**Engineer:** Two real options: add opt_in_email and opt_in_push columns to the existing users table, or create a dedicated notification_preferences table keyed by user id and channel. We already know push and in-app channels are on the near-term roadmap, and the users table would need a new migration every time a channel is added.

**Product:** Go with the dedicated table then, even though it costs us a join on every preference read.

**Engineer:** Agreed. Dedicated notification_preferences table it is.

<!-- MANIFEST-START -->
SKIPPED id=name-the-notifications-file choice="Name the new preferences file notifications.ts."
CAPTURED id=adr-store-notification-preferences choice="Store notification preferences in a dedicated table, not columns on users."
<!-- MANIFEST-END -->
