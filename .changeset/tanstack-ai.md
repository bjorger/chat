---
"chat": minor
---

Add TanStack AI support. `thread.post()`, `thread.reply()`, and `channel.post()` accept the stream returned by TanStack's `chat()`, and the new `chat/ai/tanstack` subpath provides `toTanStackMessages` for thread history and `createTanStackTools` for the Chat SDK toolset. Neither adds a runtime dependency on `@tanstack/ai`; the tools require zod 4.2 or newer.
