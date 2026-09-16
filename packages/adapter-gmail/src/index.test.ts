import { createMemoryState } from "@chat-adapter/state-memory";
import { createMockChatInstance } from "@chat-adapter/tests";
import { afterEach, describe, expect, it, vi } from "vitest";
import { composeGmailMessage, parseGmailMessage } from "./format";
import { createGmailAdapter } from "./index";
import type { GmailAdapterConfig } from "./types";

const config: GmailAdapterConfig = {
  mailbox: "agent@example.com",
  labelId: "Label_123",
  accessToken: "test-token",
  pubsubAudience: "https://example.com/gmail",
  pubsubServiceAccountEmail: "push@project.iam.gserviceaccount.com",
  subscription: "projects/project/subscriptions/mail",
};
const message = {
  id: "message",
  threadId: "thread",
  internalDate: "1788481753000",
  labelIds: ["INBOX", "Label_123"],
  raw: Buffer.from(
    [
      "From: sender@example.com",
      "To: agent@example.com",
      "Subject: review",
      "Message-ID: <original@example.com>",
      "",
      "please review",
    ].join("\r\n")
  ).toString("base64url"),
};

describe("Gmail optional Chat adapter", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([
    [400, "badRequest", "ValidationError"],
    [401, "authError", "AuthenticationError"],
    [403, "domainPolicy", "PermissionError"],
    [403, "userRateLimitExceeded", "AdapterRateLimitError"],
    [404, "notFound", "ResourceNotFoundError"],
    [429, "rateLimitExceeded", "AdapterRateLimitError"],
    [503, "backendError", "NetworkError"],
  ])("maps Gmail HTTP %s (%s) to a Chat error", async (status, reason, name) => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      Response.json(
        {
          error: { errors: [{ reason }] },
        },
        { status: Number(status) }
      )
    );
    const adapter = createGmailAdapter({ ...config, fetch });
    const source = adapter.parseMessage(await parseGmailMessage(message));
    await expect(
      adapter.fetchMessage(source.threadId, source.id)
    ).rejects.toMatchObject({ name });
  });

  it("does not read the sent message after Gmail accepts a reply", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementation((input, options) => {
        if (options?.method === "POST") {
          return Promise.resolve(
            Response.json({ id: "sent", threadId: "thread" })
          );
        }
        if (String(input).includes("/messages/message?")) {
          return Promise.resolve(Response.json(message));
        }
        return Promise.resolve(new Response("unavailable", { status: 503 }));
      });
    const adapter = createGmailAdapter({ ...config, fetch });
    const source = adapter.parseMessage(await parseGmailMessage(message));
    const result = await adapter.reply(source.threadId, source.id, "reviewed");
    expect(result.raw.text.trim()).toBe("reviewed");
    expect(result.raw.message.id).toBe("sent");
    expect(result.raw.message.labelIds).toContain("SENT");
    expect(
      fetch.mock.calls.map(([input]) => new URL(String(input)).pathname)
    ).toEqual([
      "/gmail/v1/users/agent%40example.com/messages/message",
      "/gmail/v1/users/agent%40example.com/messages/send",
    ]);
  });

  it("prefers explicit OAuth configuration over an environment access token", async () => {
    vi.stubEnv("GMAIL_ACCESS_TOKEN", "wrong-mailbox-token");
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        Response.json({ access_token: "configured-token", expires_in: 3600 })
      )
      .mockResolvedValueOnce(Response.json(message));
    const adapter = createGmailAdapter({
      ...config,
      accessToken: undefined,
      clientId: "client",
      clientSecret: "secret",
      refreshToken: "refresh",
      fetch,
    });
    const source = adapter.parseMessage(await parseGmailMessage(message));
    await adapter.fetchMessage(source.threadId, source.id);
    expect(fetch.mock.calls[0][0]).toBe("https://oauth2.googleapis.com/token");
    expect(fetch.mock.calls[1][1]?.headers).toMatchObject({
      authorization: "Bearer configured-token",
    });
  });

  it.each([
    "invalid_grant",
    "invalid_client",
    "deleted_client",
  ])("reports OAuth %s as an authentication failure before reading email", async (reason) => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(Response.json({ error: reason }, { status: 400 }));
    const adapter = createGmailAdapter({
      ...config,
      accessToken: undefined,
      clientId: "client",
      clientSecret: "secret",
      refreshToken: "refresh",
      fetch,
    });
    const source = adapter.parseMessage(await parseGmailMessage(message));
    await expect(
      adapter.fetchMessage(source.threadId, source.id)
    ).rejects.toMatchObject({ name: "AuthenticationError" });
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0][0]).toBe("https://oauth2.googleapis.com/token");
  });

  it("does not send if streaming is cancelled while resolving its reply target", async () => {
    const controller = new AbortController();
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementation((input) => {
        if (String(input).includes("/threads/")) {
          controller.abort();
          return Promise.resolve(
            Response.json({
              id: "thread",
              messages: [{ id: "message", threadId: "thread" }],
            })
          );
        }
        return Promise.resolve(Response.json(message));
      });
    const adapter = createGmailAdapter({ ...config, fetch });
    const source = adapter.parseMessage(await parseGmailMessage(message));
    async function* chunks() {
      yield "reply";
    }
    await expect(
      adapter.stream(source.threadId, chunks(), { signal: controller.signal })
    ).rejects.toThrow();
    expect(
      fetch.mock.calls.every(([, options]) => options?.method !== "POST")
    ).toBe(true);
  });
  it("leaves watch registration explicit and dispatches selected email through Chat", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        Response.json({ emailAddress: "agent@example.com", historyId: "100" })
      )
      .mockResolvedValueOnce(
        Response.json({ historyId: "100", expiration: "1789086553000" })
      )
      .mockResolvedValueOnce(
        Response.json({
          historyId: "200",
          history: [
            {
              id: "150",
              labelsAdded: [
                {
                  message: { id: "message", threadId: "thread" },
                  labelIds: ["Label_123"],
                },
              ],
            },
          ],
        })
      )
      .mockResolvedValueOnce(Response.json(message))
      .mockResolvedValueOnce(Response.json(message));
    const state = createMemoryState();
    await state.connect();
    try {
      const chat = createMockChatInstance({ state });
      const adapter = createGmailAdapter({ ...config, fetch });
      await adapter.initialize(chat);
      expect(fetch).not.toHaveBeenCalled();
      await adapter.watch("projects/project/topics/mail");
      await adapter.sync();
      expect(chat.processMessage).toHaveBeenCalledWith(
        adapter,
        adapter.encodeThreadId({
          mailbox: "agent@example.com",
          threadId: "thread",
        }),
        expect.objectContaining({ text: "please review\n", isMention: true })
      );
    } finally {
      await state.disconnect();
    }
  });

  it("uses mailbox-scoped Chat IDs while keeping native IDs in raw data", async () => {
    const adapter = createGmailAdapter(config);
    const source = await parseGmailMessage(message);
    const parsed = adapter.parseMessage(source);
    expect(parsed.id).not.toBe(message.id);
    expect(parsed.raw.message.id).toBe(message.id);
    expect(adapter.decodeThreadId(parsed.threadId)).toEqual({
      mailbox: "agent@example.com",
      threadId: "thread",
    });
    const another = createGmailAdapter({
      ...config,
      mailbox: "another@example.com",
    });
    expect(another.parseMessage(source).id).not.toBe(parsed.id);
    expect(() => another.decodeThreadId(parsed.threadId)).toThrow("another");
  });

  it("restores attachment bytes using native message IDs instead of stored URLs", async () => {
    const payload = {
      ...message,
      raw: composeGmailMessage({
        from: "sender@example.com",
        to: [{ address: "agent@example.com" }],
        text: "review these files",
        attachments: [
          {
            filename: "first.txt",
            mimeType: "text/plain",
            data: Buffer.from("first"),
          },
          {
            filename: "second.txt",
            mimeType: "text/plain",
            data: Buffer.from("second"),
          },
        ],
      }),
    };
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(Response.json(payload));
    const adapter = createGmailAdapter({ ...config, fetch });
    const parsed = adapter.parseMessage(await parseGmailMessage(payload));
    expect(parsed.attachments[1]).toMatchObject({
      name: "second.txt",
      mimeType: "text/plain",
      size: 6,
    });
    await expect(parsed.attachments[1].fetchData?.()).resolves.toEqual(
      Buffer.from("second")
    );
    expect(fetch).not.toHaveBeenCalled();
    const restored = adapter.rehydrateAttachment({
      type: "file",
      url: "https://169.254.169.254/private",
      fetchMetadata: {
        ...parsed.attachments[1].fetchMetadata,
        url: "https://attacker.example/file",
      },
    });
    await expect(restored.fetchData?.()).resolves.toEqual(
      Buffer.from("second")
    );
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0][0]).toBe(
      "https://gmail.googleapis.com/gmail/v1/users/agent%40example.com/messages/message?format=raw"
    );
  });

  it.each([
    { mailbox: "another@example.com", messageId: "message", index: "0" },
    { mailbox: "agent@example.com", messageId: "../profile", index: "0" },
    {
      mailbox: "agent@example.com",
      messageId: "https://attacker.example/file",
      index: "0",
    },
    { mailbox: "agent@example.com", messageId: "message", index: "-1" },
    { mailbox: "agent@example.com", messageId: "message", index: "1.5" },
  ])("rejects unsafe attachment metadata before accessing Gmail: %j", async (fetchMetadata) => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const adapter = createGmailAdapter({ ...config, fetch });
    const attachment = adapter.rehydrateAttachment({
      type: "file",
      fetchMetadata,
    });
    await expect(attachment.fetchData?.()).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("reports a missing restored attachment without fetching an external fallback", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(Response.json(message));
    const adapter = createGmailAdapter({ ...config, fetch });
    const attachment = adapter.rehydrateAttachment({
      type: "file",
      url: "https://attacker.example/file",
      fetchMetadata: {
        mailbox: "agent@example.com",
        messageId: "message",
        index: "0",
      },
    });
    await expect(attachment.fetchData?.()).rejects.toMatchObject({
      name: "ResourceNotFoundError",
    });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("buffers a stream and delegates to postMessage only after completion", async () => {
    const adapter = createGmailAdapter(config);
    const raw = await parseGmailMessage(message);
    const result = { id: "sent", threadId: "thread", raw };
    const post = vi.spyOn(adapter, "postMessage").mockResolvedValue(result);
    async function* chunks() {
      yield "hello ";
      expect(post).not.toHaveBeenCalled();
      yield { type: "markdown_text" as const, text: "world" };
    }
    await expect(adapter.stream("thread", chunks())).resolves.toBe(result);
    expect(post).toHaveBeenCalledExactlyOnceWith(
      "thread",
      {
        raw: "hello world",
      },
      undefined
    );
  });

  it("does not send partial email after a failed or cancelled stream", async () => {
    const adapter = createGmailAdapter(config);
    const post = vi.spyOn(adapter, "postMessage");
    const controller = new AbortController();
    async function* cancelled() {
      yield "partial";
      controller.abort();
    }
    await expect(
      adapter.stream("thread", cancelled(), { signal: controller.signal })
    ).rejects.toThrow();
    async function* failed() {
      yield "partial";
      throw new Error("stream failed");
    }
    await expect(adapter.stream("thread", failed())).rejects.toThrow(
      "stream failed"
    );
    expect(post).not.toHaveBeenCalled();
  });
});
