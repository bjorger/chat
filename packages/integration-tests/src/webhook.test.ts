import { createSlackAdapter } from "@chat-adapter/slack";
import { createMemoryState } from "@chat-adapter/state-memory";
import { TeamsAdapter } from "@chat-adapter/teams";
import { type ActionEvent, Chat, type ChatInstance, ConsoleLogger } from "chat";
import { describe, expect, it, vi } from "vitest";
import {
  createMockSlackClient,
  createSlackWebhookRequest,
  injectMockSlackClient,
  SLACK_BOT_TOKEN,
  SLACK_BOT_USER_ID,
  SLACK_SIGNING_SECRET,
} from "./slack-utils";

const logger = new ConsoleLogger("silent");

class DialogAdapter extends TeamsAdapter {
  override async initialize(chat: ChatInstance): Promise<void> {
    this.chat = chat;
    this.bridgeAdapter.registerRoute(
      "POST",
      "/api/messages",
      async ({ body }) => {
        const result = await this.handleDialogOpen({
          activity: body,
        } as Parameters<typeof this.handleDialogOpen>[0]);
        return { status: 200, body: result };
      }
    );
  }
}

function slack() {
  const adapter = createSlackAdapter({
    agentView: true,
    sessionTitle: false,
    botToken: SLACK_BOT_TOKEN,
    botUserId: SLACK_BOT_USER_ID,
    signingSecret: SLACK_SIGNING_SECRET,
    logger,
  });
  injectMockSlackClient(adapter, createMockSlackClient());
  const state = createMemoryState();
  const chat = new Chat({
    userName: "bot",
    adapters: { slack: adapter },
    state,
    logger,
  });
  const request = createSlackWebhookRequest({
    type: "event_callback",
    event_id: "Ev1",
    event: {
      type: "message",
      channel: "D1",
      channel_type: "im",
      user: "U1",
      text: "hello",
      ts: "1771.99",
    },
  });
  return { chat, state, request };
}

describe.each([
  undefined,
  false,
  true,
])("webhook handler errors with propagateHandlerErrors=%s", (propagateHandlerErrors) => {
  it.each([
    false,
    true,
  ])("tracks delayed Slack agent-view handlers when failing=%s", async (failing) => {
    const { chat, state, request } = slack();
    const error = new Error("Database admission failed");
    const handler = vi.fn(async () => {
      if (failing) {
        throw error;
      }
    });
    chat.onDirectMessage(handler);

    let release = () => {};
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(state, "isSubscribed").mockImplementationOnce(async () => {
      await pending;
      return false;
    });
    const tasks: Promise<unknown>[] = [];

    try {
      const response = await chat.webhooks.slack(request, {
        propagateHandlerErrors,
        waitUntil: (task) => tasks.push(task),
      });
      expect(response.status).toBe(200);
      expect(handler).not.toHaveBeenCalled();
      expect(tasks).toHaveLength(1);

      const settled = Promise.allSettled(tasks);
      release();
      const results = await settled;
      await Promise.allSettled(tasks);

      expect(handler).toHaveBeenCalledOnce();
      expect(tasks).toHaveLength(2);
      expect(results).toEqual([
        failing && propagateHandlerErrors
          ? { status: "rejected", reason: error }
          : { status: "fulfilled", value: undefined },
      ]);
    } finally {
      release();
      await Promise.allSettled(tasks);
      await chat.shutdown();
    }
  });

  it.each([
    false,
    true,
  ])("tracks Teams dialog action handlers when failing=%s", async (failing) => {
    const adapter = new DialogAdapter({
      appId: "test-app",
      appPassword: "test-password",
      logger,
    });
    const chat = new Chat({
      userName: "bot",
      adapters: { teams: adapter },
      state: createMemoryState(),
      logger,
    });
    const error = new Error("Database admission failed");
    const handler = vi.fn(async (event: ActionEvent) => {
      if (failing) {
        throw error;
      }
      await event.openModal({
        type: "modal",
        callbackId: "review",
        title: "Review",
        children: [],
      });
    });
    chat.onAction("review", handler);
    const tasks: Promise<unknown>[] = [];

    try {
      const response = await chat.webhooks.teams(
        new Request("https://example.com/api/messages", {
          method: "POST",
          body: JSON.stringify({
            type: "invoke",
            name: "task/fetch",
            id: "activity-1",
            from: { id: "user-1", name: "User" },
            conversation: { id: "a:group", conversationType: "groupChat" },
            serviceUrl: "https://smba.trafficmanager.net/teams/",
            value: { data: { actionId: "review" } },
          }),
        }),
        { propagateHandlerErrors, waitUntil: (task) => tasks.push(task) }
      );
      const results = await Promise.allSettled(tasks);

      expect(response.status).toBe(200);
      expect(handler).toHaveBeenCalledOnce();
      expect(results).toEqual([
        failing && propagateHandlerErrors
          ? { status: "rejected", reason: error }
          : { status: "fulfilled", value: undefined },
      ]);
      if (!failing) {
        expect(await response.json()).toMatchObject({
          task: { type: "continue", value: { title: "Review" } },
        });
      }
    } finally {
      await Promise.allSettled(tasks);
      await chat.shutdown();
    }
  });
});

it("keeps Slack failures handled without a waitUntil callback", async () => {
  const { chat, request } = slack();
  const handler = vi
    .fn()
    .mockRejectedValue(new Error("Database admission failed"));
  chat.onDirectMessage(handler);

  try {
    const response = await chat.webhooks.slack(request, {
      propagateHandlerErrors: true,
    });
    await vi.waitFor(() => expect(handler).toHaveBeenCalledOnce());
    expect(response.status).toBe(200);
  } finally {
    await chat.shutdown();
  }
});
