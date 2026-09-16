import { createHash } from "node:crypto";
import { createMemoryState } from "@chat-adapter/state-memory";
import {
  createTelegramAdapter,
  type TelegramUpdate,
} from "@chat-adapter/telegram";
import { Chat, ConsoleLogger } from "chat";
import { afterEach, describe, expect, it, vi } from "vitest";

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function message(id: number) {
  return {
    update_id: id,
    message: {
      message_id: id,
      date: 1,
      text: "hello",
      chat: { id: 1, type: "private" },
      from: { id: 2, is_bot: false, first_name: "User" },
    },
  } satisfies TelegramUpdate;
}

function album() {
  return [1, 2].map((id) => ({
    update_id: id,
    message: {
      ...message(id).message,
      media_group_id: "album",
      photo: [
        {
          file_id: String(id),
          file_unique_id: String(id),
          width: 10,
          height: 10,
        },
      ],
    },
  }));
}

const checkpoint = `telegram:polling:${createHash("sha256").update("999").digest("hex")}`;

function fixture(
  updates: TelegramUpdate[],
  state = createMemoryState(),
  identity = 999,
  allowedUserIds?: string[]
) {
  const polls: { offset?: number; limit: number }[] = [];
  let deliver = () => {};
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>(async (input, options) => {
      const method = String(input).split("/").at(-1);
      let result: unknown = true;
      if (method === "getMe") {
        result = {
          id: identity,
          is_bot: true,
          first_name: "Bot",
          username: "bot",
        };
      }
      if (method === "getUpdates") {
        const payload = JSON.parse(String(options?.body)) as {
          offset?: number;
          limit: number;
        };
        polls.push(payload);
        const pending = updates
          .filter((update) => update.update_id >= (payload.offset ?? 0))
          .slice(0, payload.limit);
        if (pending.length === 0) {
          return new Promise<Response>((resolve, reject) => {
            const abort = () => {
              deliver = () => {};
              reject(new DOMException("Stopped", "AbortError"));
            };
            deliver = () => {
              const arrivals = updates
                .filter((update) => update.update_id >= (payload.offset ?? 0))
                .slice(0, payload.limit);
              if (arrivals.length > 0) {
                deliver = () => {};
                options?.signal?.removeEventListener("abort", abort);
                resolve(Response.json({ ok: true, result: arrivals }));
              }
            };
            if (options?.signal?.aborted) {
              abort();
            } else {
              options?.signal?.addEventListener("abort", abort, { once: true });
            }
          });
        }
        result = pending;
      }
      return Response.json({ ok: true, result });
    })
  );
  const adapter = createTelegramAdapter({
    botToken: "test-token",
    mode: "webhook",
    secretToken: "test-secret",
    allowedUserIds,
    logger: new ConsoleLogger("silent"),
  });
  const bot = new Chat({
    userName: "bot",
    adapters: { telegram: adapter },
    state,
    concurrency: "concurrent",
    logger: "silent",
  });
  return {
    bot,
    adapter,
    polls,
    state,
    deliver(update: TelegramUpdate) {
      updates.push(update);
      deliver();
    },
    async start(limit = 100) {
      await bot.initialize();
      await adapter.startPolling({ limit, retryDelayMs: 10, timeout: 1 });
    },
    async stop() {
      await adapter.stopPolling();
      await bot.shutdown();
    },
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("Telegram polling admission", () => {
  const ordinary = message(1);
  const command: TelegramUpdate = {
    update_id: 1,
    message: {
      ...ordinary.message,
      text: "/help",
      entities: [{ type: "bot_command", offset: 0, length: 5 }],
    },
  };
  const action: TelegramUpdate = {
    update_id: 1,
    callback_query: {
      id: "callback",
      chat_instance: "instance",
      from: ordinary.message.from,
      message: ordinary.message,
      data: "approve",
    },
  };
  const reaction: TelegramUpdate = {
    update_id: 1,
    message_reaction: {
      chat: ordinary.message.chat,
      message_id: 1,
      date: 1,
      user: ordinary.message.from,
      old_reaction: [],
      new_reaction: [{ type: "custom_emoji", custom_emoji_id: "reaction" }],
    },
  };

  it.each([
    ["message", ordinary],
    ["command", command],
    ["action", action],
    ["reaction", reaction],
  ] as const)("retries a failed %s and waits for successful admission", async (_name, update) => {
    const test = fixture([update]);
    const gate = deferred();
    const handler = vi.fn(async () => {
      if (handler.mock.calls.length === 1) {
        throw new Error("Admission failed");
      }
      await gate.promise;
    });
    test.bot.onNewMention(handler);
    test.bot.onSlashCommand(handler);
    test.bot.onAction(handler);
    test.bot.onReaction(handler);
    try {
      await test.start();
      await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(2));
      expect(test.polls.every((poll) => poll.offset === undefined)).toBe(true);
      gate.resolve();
      await vi.waitFor(() => expect(test.polls.at(-1)?.offset).toBe(2));
      expect(handler).toHaveBeenCalledTimes(2);
    } finally {
      gate.resolve();
      await test.stop();
    }
  });

  it("settles the entire batch before retrying and does not repeat successful updates", async () => {
    const test = fixture([message(1), { ...action, update_id: 2 }]);
    const gate = deferred();
    const failed = vi.fn().mockRejectedValueOnce(new Error("Admission failed"));
    const pending = vi.fn(() => gate.promise);
    test.bot.onNewMention(failed);
    test.bot.onAction(pending);
    try {
      await test.start();
      await vi.waitFor(() => expect(pending).toHaveBeenCalledTimes(1));
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(test.polls).toHaveLength(1);
      gate.resolve();
      await vi.waitFor(() => expect(test.polls.at(-1)?.offset).toBe(3));
      expect(failed).toHaveBeenCalledTimes(2);
      expect(pending).toHaveBeenCalledTimes(1);
    } finally {
      gate.resolve();
      await test.stop();
    }
  });

  it.each([
    ordinary,
    command,
    action,
    reaction,
  ])("preserves default webhook error handling for $update_id", async (update) => {
    const test = fixture([]);
    const handler = vi.fn().mockRejectedValue(new Error("Admission failed"));
    test.bot.onNewMention(handler);
    test.bot.onSlashCommand(handler);
    test.bot.onAction(handler);
    test.bot.onReaction(handler);
    const tasks: Promise<unknown>[] = [];
    try {
      const response = await test.bot.webhooks.telegram(
        new Request("https://example.com/webhooks/telegram", {
          method: "POST",
          headers: { "X-Telegram-Bot-Api-Secret-Token": "test-secret" },
          body: JSON.stringify(update),
        }),
        { waitUntil: (task) => tasks.push(task) }
      );
      expect(response.status).toBe(200);
      const results = await Promise.allSettled(tasks);
      expect(handler).toHaveBeenCalledOnce();
      expect(results.every((result) => result.status === "fulfilled")).toBe(
        true
      );
    } finally {
      await Promise.allSettled(tasks);
      await test.stop();
    }
  });

  it("retries every member of a failed album", async () => {
    const updates = [1, 2].map((id) => ({
      update_id: id,
      message: {
        ...ordinary.message,
        message_id: id,
        media_group_id: "album",
        photo: [
          {
            file_id: String(id),
            file_unique_id: String(id),
            width: 10,
            height: 10,
          },
        ],
      },
    }));
    const test = fixture(updates);
    const handler = vi
      .fn()
      .mockRejectedValueOnce(new Error("Admission failed"));
    test.bot.onNewMention(handler);
    try {
      await test.start();
      await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(2), {
        timeout: 5000,
      });
      expect(test.polls.at(-1)?.offset).toBe(3);
      for (const [, received] of handler.mock.calls) {
        expect(received.attachments).toHaveLength(2);
      }
      await vi.waitFor(async () =>
        expect(await test.state.get(checkpoint)).toBeNull()
      );
    } finally {
      await test.stop();
    }
  });

  it("combines an album across polling responses after persisting its members", async () => {
    const test = fixture(album());
    const handler = vi.fn();
    test.bot.onNewMention(handler);
    try {
      await test.start(1);
      await vi.waitFor(async () => {
        expect(test.polls.at(-1)?.offset).toBe(3);
        expect(await test.state.get(checkpoint)).toMatchObject({
          offset: 3,
          pending: [{ update: { update_id: 1 } }, { update: { update_id: 2 } }],
        });
      });
      expect(handler).not.toHaveBeenCalled();
      await vi.waitFor(() => expect(handler).toHaveBeenCalledOnce(), {
        timeout: 5000,
      });
      expect(handler.mock.calls[0]?.[1].attachments).toHaveLength(2);
      await vi.waitFor(async () =>
        expect(await test.state.get(checkpoint)).toBeNull()
      );
    } finally {
      await test.stop();
    }
  });

  it("does not acknowledge album members when checkpoint persistence fails", async () => {
    const test = fixture(album());
    const save = test.state.set.bind(test.state);
    let failing = true;
    vi.spyOn(test.state, "set").mockImplementation(async (key, value, ttl) => {
      if (key === checkpoint && failing) {
        throw new Error("Storage unavailable");
      }
      await save(key, value, ttl);
    });
    const handler = vi.fn();
    test.bot.onNewMention(handler);
    try {
      await test.start(1);
      await vi.waitFor(() => expect(test.polls.length).toBeGreaterThan(1));
      expect(test.polls.every((poll) => poll.offset === undefined)).toBe(true);
      expect(handler).not.toHaveBeenCalled();
      failing = false;
      await vi.waitFor(() => expect(handler).toHaveBeenCalledOnce(), {
        timeout: 5000,
      });
      expect(handler.mock.calls[0]?.[1].attachments).toHaveLength(2);
    } finally {
      failing = false;
      await test.stop();
    }
  });

  it("recovers acknowledged album parts on a fresh adapter and state connection", async () => {
    const first = fixture(album());
    let saved: unknown;
    try {
      await first.start(1);
      await vi.waitFor(async () => {
        saved = await first.state.get(checkpoint);
        expect(saved).toMatchObject({ offset: 3, pending: [{}, {}] });
      });
    } finally {
      await first.stop();
    }
    const state = createMemoryState();
    await state.connect();
    await state.set(checkpoint, JSON.parse(JSON.stringify(saved)));
    await state.set("dedupe:telegram:1:2", true);
    await state.set("telegram:incoming-media-group:telegram:1:album", [
      { message: album()[0].message, receivedAt: Date.now() },
    ]);
    const second = fixture([], state);
    const handler = vi.fn();
    second.bot.onNewMention(handler);
    try {
      await second.start(1);
      await vi.waitFor(() => expect(handler).toHaveBeenCalledOnce(), {
        timeout: 5000,
      });
      expect(handler.mock.calls[0]?.[1].attachments).toHaveLength(2);
      await vi.waitFor(async () =>
        expect(await state.get(checkpoint)).toBeNull()
      );
      expect(second.polls.every((poll) => poll.offset === 3)).toBe(true);
    } finally {
      await second.stop();
    }
  });

  it("combines an album spanning a full polling response", async () => {
    const updates = Array.from({ length: 102 }, (_, index) => {
      const update = album()[index % 2];
      return {
        ...update,
        update_id: index + 1,
        message: {
          ...update.message,
          message_id: index + 1,
          media_group_id: String(Math.floor(index / 3)),
        },
      };
    });
    const test = fixture(updates);
    const handler = vi.fn();
    test.bot.onNewMention(handler);
    try {
      await test.start(100);
      await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(34), {
        timeout: 8000,
      });
      for (const [, received] of handler.mock.calls) {
        expect(received.attachments).toHaveLength(3);
      }
      await vi.waitFor(async () =>
        expect(await test.state.get(checkpoint)).toBeNull()
      );
    } finally {
      await test.stop();
    }
  });

  it("includes parts arriving while the collection poll is waiting", async () => {
    const parts = album();
    const test = fixture([parts[0]]);
    const handler = vi.fn();
    test.bot.onNewMention(handler);
    try {
      await test.start(1);
      await vi.waitFor(() => expect(test.polls.at(-1)?.offset).toBe(2));
      await new Promise((resolve) => setTimeout(resolve, 100));
      test.deliver(parts[1]);
      await vi.waitFor(() => expect(handler).toHaveBeenCalledOnce(), {
        timeout: 5000,
      });
      expect(handler.mock.calls[0]?.[1].attachments).toHaveLength(2);
    } finally {
      await test.stop();
    }
  });

  it("does not replay another bot's saved album", async () => {
    const state = createMemoryState();
    await state.connect();
    const saved = {
      offset: 3,
      pending: album().map((update) => ({ update, receivedAt: 0 })),
    };
    await state.set(checkpoint, saved);
    const test = fixture([], state, 1000);
    const handler = vi.fn();
    test.bot.onNewMention(handler);
    try {
      await test.start();
      await vi.waitFor(() => expect(test.polls).toHaveLength(1));
      expect(handler).not.toHaveBeenCalled();
      expect(await state.get(checkpoint)).toEqual(saved);
      expect(test.polls[0].offset).toBeUndefined();
    } finally {
      await test.stop();
    }
  });

  it("does not buffer albums from users outside the allowlist", async () => {
    const test = fixture(album(), createMemoryState(), 999, ["3"]);
    const save = vi.spyOn(test.state, "set");
    const handler = vi.fn();
    test.bot.onNewMention(handler);
    try {
      await test.start(1);
      await vi.waitFor(() => expect(test.polls.at(-1)?.offset).toBe(3));
      expect(handler).not.toHaveBeenCalled();
      expect(save.mock.calls.some(([key]) => key === checkpoint)).toBe(false);
    } finally {
      await test.stop();
    }
  });

  it("keeps pending albums through cleanup failures without repeating successful handlers", async () => {
    const test = fixture(album());
    const remove = test.state.delete.bind(test.state);
    let failures = 0;
    vi.spyOn(test.state, "delete").mockImplementation(async (key) => {
      if (key === checkpoint && failures++ === 0) {
        throw new Error("Cleanup failed");
      }
      await remove(key);
    });
    const handler = vi.fn();
    test.bot.onNewMention(handler);
    try {
      await test.start(1);
      await vi.waitFor(() => expect(handler).toHaveBeenCalledOnce(), {
        timeout: 5000,
      });
      await vi.waitFor(async () =>
        expect(await test.state.get(checkpoint)).toBeNull()
      );
      expect(handler).toHaveBeenCalledOnce();
    } finally {
      await test.stop();
    }
  });

  it("waits for admitted work during shutdown without acknowledging unfinished input", async () => {
    const test = fixture([ordinary]);
    const gate = deferred();
    const handler = vi.fn(() => gate.promise);
    test.bot.onNewMention(handler);
    let stopped = false;
    try {
      await test.start();
      await vi.waitFor(() => expect(handler).toHaveBeenCalledOnce());
      const stopping = test.bot.shutdown().then(() => {
        stopped = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(stopped).toBe(false);
      expect(test.polls).toHaveLength(1);
      gate.resolve();
      await stopping;
      expect(test.polls).toHaveLength(1);
    } finally {
      gate.resolve();
      await test.stop();
    }
  });
});
