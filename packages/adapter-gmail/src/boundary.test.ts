import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const execute = promisify(execFile);
const directory = fileURLToPath(new URL("..", import.meta.url));
const dependencies = new Set([
  "html-to-text",
  "mimetext",
  "postal-mime",
  "jose",
  "zod",
]);
const extension = /\.(?:js|mjs)$/;

function inspect(file: string, visited = new Set<string>()): void {
  if (visited.has(file)) {
    return;
  }
  visited.add(file);
  const source = ts.preProcessFile(readFileSync(file, "utf8"), true, true);
  for (const imported of source.importedFiles) {
    const specifier = imported.fileName;
    if (specifier.startsWith("node:")) {
      continue;
    }
    if (!specifier.startsWith(".")) {
      if (!dependencies.has(specifier)) {
        throw new Error(`${file} imports ${specifier}`);
      }
      continue;
    }
    const target = resolve(dirname(file), specifier);
    const candidates = [
      target,
      `${target}.ts`,
      target.replace(extension, ".d.ts"),
    ];
    const dependency = candidates.find(
      (candidate) => candidate.endsWith(".ts") && existsSync(candidate)
    );
    if (!dependency) {
      throw new Error(`Cannot resolve ${specifier} from ${file}`);
    }
    if (dependency === resolve(directory, "src/index.ts")) {
      throw new Error(`${file} imports the full adapter`);
    }
    inspect(dependency, visited);
  }
}

const loader = `
export async function resolve(specifier, context, next) {
  if (
    specifier === "chat" || specifier.startsWith("chat/") ||
    specifier === "ai" || specifier.startsWith("ai/") ||
    specifier.startsWith("@chat-adapter/shared") ||
    specifier.startsWith("googleapis") ||
    specifier.startsWith("google-auth-library")
  ) {
    throw new Error("Forbidden runtime: " + specifier);
  }
  return next(specifier, context);
}
`;
const bootstrap = `
import { register } from "node:module";
register(${JSON.stringify(`data:text/javascript,${encodeURIComponent(loader)}`)}, import.meta.url);
`;

describe("Gmail primitive boundaries", () => {
  it.each([
    "api",
    "format",
    "webhook",
  ])("%s keeps source and published types independent of Chat", (entry) => {
    expect(() => inspect(resolve(directory, `src/${entry}.ts`))).not.toThrow();
    expect(() =>
      inspect(resolve(directory, `dist/${entry}.d.ts`))
    ).not.toThrow();
  });

  it("uses published primitives while the Chat runtime is blocked", async () => {
    const script = `${bootstrap}
      const api = await import("@chat-adapter/gmail/api");
      const format = await import("@chat-adapter/gmail/format");
      const webhook = await import("@chat-adapter/gmail/webhook");
      const profile = await api.getGmailProfile({
        mailbox: "agent@example.com",
        token: async () => "test-token",
        fetch: async () => Response.json({
          emailAddress: "agent@example.com", historyId: "9007199254740993"
        })
      });
      const labels = await api.listGmailLabels({
        mailbox: profile.emailAddress,
        token: "test-token",
        fetch: async () => Response.json({ labels: [
          { id: "Label_123", name: "agent/review", type: "user" }
        ] })
      });
      await api.stopGmailMailbox({
        mailbox: profile.emailAddress,
        token: "test-token",
        fetch: async () => Response.json({})
      });
      const raw = format.composeGmailMessage({
        from: profile.emailAddress,
        to: [{ address: "sender@example.com" }],
        subject: "review", text: "reviewed"
      });
      const parsed = await format.parseGmailMessage({
        id: "abc", threadId: "def", internalDate: "1788481753000",
        labelIds: [], raw
      });
      const notification = webhook.parseGmailNotification(JSON.stringify({
        subscription: "projects/project/subscriptions/mail",
        message: {
          messageId: "delivery",
          data: Buffer.from(JSON.stringify(profile)).toString("base64")
        }
      }));
      webhook.createGmailWebhookVerifier({
        audience: "https://example.com/gmail",
        serviceAccountEmail: "push@project.iam.gserviceaccount.com",
        subscription: notification.subscription
      });
      process.stdout.write(JSON.stringify({
        text: parsed.text.trim(), historyId: notification.historyId,
        label: labels.labels[0].id
      }));
    `;
    const { stdout } = await execute(
      process.execPath,
      ["--input-type=module", "--eval", script],
      { cwd: directory }
    );
    expect(stdout).toBe(
      JSON.stringify({
        text: "reviewed",
        historyId: "9007199254740993",
        label: "Label_123",
      })
    );
  });

  it("blocks the full adapter under the same runtime guard", async () => {
    await expect(
      execute(
        process.execPath,
        [
          "--input-type=module",
          "--eval",
          `${bootstrap} await import("@chat-adapter/gmail");`,
        ],
        { cwd: directory }
      )
    ).rejects.toThrow("Forbidden runtime:");
  });

  it("supports the full Chat adapter when the consumer opts in", async () => {
    const script = `
      const { createGmailAdapter } = await import("@chat-adapter/gmail");
      const { Chat } = await import("chat");
      const { createMemoryState } = await import("@chat-adapter/state-memory");
      const gmail = createGmailAdapter({
        mailbox: "agent@example.com", labelId: "Label_123", accessToken: "test-token",
        pubsubAudience: "https://example.com/gmail",
        pubsubServiceAccountEmail: "push@project.iam.gserviceaccount.com",
        subscription: "projects/project/subscriptions/mail"
      });
      const bot = new Chat({
        userName: "agent", adapters: { gmail }, state: createMemoryState()
      });
      process.stdout.write(JSON.stringify({
        name: gmail.name, webhook: typeof bot.webhooks.gmail,
        native: gmail.decodeThreadId(gmail.encodeThreadId({
          mailbox: "agent@example.com", threadId: "native-thread"
        }))
      }));
    `;
    const { stdout } = await execute(
      process.execPath,
      ["--input-type=module", "--eval", script],
      { cwd: directory }
    );
    expect(stdout).toBe(
      JSON.stringify({
        name: "gmail",
        webhook: "function",
        native: { mailbox: "agent@example.com", threadId: "native-thread" },
      })
    );
  });
});
