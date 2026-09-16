---
"@chat-adapter/gchat": patch
---

`editMessage`, `deleteMessage`, `addReaction`, and `removeReaction` now require the message id to be a well-formed `spaces/{space}/messages/{message}` resource name in the thread's space before calling the Google Chat API. Message ids identify a message on their own, so a permitted thread id could previously be paired with a message from another space, including names that only resolved there after path normalization. The adapter also gains `fetchMessage()`, which returns a message with the thread Google reports for it.
