---
"@chat-adapter/gchat": patch
---

`editMessage`, `deleteMessage`, `addReaction`, and `removeReaction` now verify that the message belongs to the thread's space before calling the Google Chat API. Message ids are full resource names that identify a message on their own, so a permitted thread id could previously be paired with a message from another space.
