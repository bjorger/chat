[![Gmail adapter for Chat SDK](https://chat-sdk.dev/en/adapters/official/gmail/og)](https://chat-sdk.dev/adapters/official/gmail)

# @chat-adapter/gmail

> npm package: [`@chat-adapter/gmail`](https://www.npmjs.com/package/@chat-adapter/gmail)

Gmail primitives and an optional Chat SDK adapter. Local implementation in progress, not ready for release or verified against a live mailbox yet.

Documentation: [Gmail adapter](https://chat-sdk.dev/adapters/official/gmail) | Guides: [Chat SDK](https://vercel.com/kb/chat-sdk)

The Gmail package, documentation and banner links are release targets. They are not published by this local implementation.

## scaffolding

Gmail is not yet registered with the CLI. For currently supported adapters, use `npx create-chat-sdk@latest` and see the [adapters directory](https://chat-sdk.dev/adapters). This local Gmail implementation requires the explicit setup below.

## import boundaries

| import | purpose | loads Chat |
| --- | --- | --- |
| `@chat-adapter/gmail/api` | OAuth token providers, messages, drafts, labels, history and watches | no |
| `@chat-adapter/gmail/format` | MIME parsing, composition and serializable reply context | no |
| `@chat-adapter/gmail/webhook` | Pub/Sub notification parsing and JWT verification | no |
| `@chat-adapter/gmail` | full Chat SDK adapter | yes |

The primitive entrypoints and their generated types do not import `chat`, `@chat-adapter/shared`, `ai`, or Google's full client SDK. They do not create handlers, subscriptions, locks, sessions, or background workers. The package still declares Chat dependencies for the optional root adapter; this is runtime isolation, not a separate installation footprint.

## without Chat

```typescript
import {
  createGmailDraft,
  createGmailTokenProvider,
  getGmailMessage,
} from "@chat-adapter/gmail/api";
import {
  extractGmailContinuation,
  parseGmailMessage,
} from "@chat-adapter/gmail/format";

const token = createGmailTokenProvider({
  clientId: process.env.GMAIL_CLIENT_ID!,
  clientSecret: process.env.GMAIL_CLIENT_SECRET!,
  refreshToken: process.env.GMAIL_REFRESH_TOKEN!,
});
const options = { mailbox: "agent@example.com", token };
const source = await getGmailMessage("native-message-id", options);
const email = await parseGmailMessage(source);
const continuation = extractGmailContinuation(email, options.mailbox);

const draft = await createGmailDraft({
  continuation,
  text: "Here is the proposed reply",
}, options);
```

An existing integration can supply its own token string or async token resolver instead of `createGmailTokenProvider`. API options also accept a fetch implementation and abort signal.

The built-in token provider refreshes before token expiry and shares simultaneous refresh requests. It does not run the initial consent flow or automatically replay API requests after authentication failures. Revoked refresh tokens require renewed consent; inspect `GmailApiError.reason` in standalone integrations. The root adapter reports rejected credentials as `AuthenticationError`. See [Google's OAuth error guidance](https://developers.google.com/identity/protocols/oauth2/web-server#authorization-errors).

Continuation data contains native Gmail IDs, mailbox, recipients, subject, and RFC reply headers. It is serializable and has no Chat subscription or session dependency. Reply-To is preferred over From; other recipients are not copied automatically. Treat email content and sender headers as untrusted input, not authorization to execute tools or send mail.

`createGmailDraft` saves a draft. `sendGmailMessage` sends immediately. The caller owns approvals, routing, persistence and retry policy. The API does not automatically retry sending email.

Both methods also accept a provider-native `{ raw, threadId? }` object when the caller already has a base64url-encoded MIME message. When constructing raw replies, the caller must include matching Subject, In-Reply-To and References headers as required by [Google's threading contract](https://developers.google.com/workspace/gmail/api/guides/threads).

## with Chat

```typescript
import { createGmailAdapter } from "@chat-adapter/gmail";
import { createMemoryState } from "@chat-adapter/state-memory";
import { Chat } from "chat";

const gmail = createGmailAdapter();
const bot = new Chat({
  userName: "agent",
  adapters: { gmail },
  state: createMemoryState(),
});

bot.onNewMention(async (thread) => {
  await thread.post("Received, I will review this email");
});
```

The root adapter currently uses label-based handoff. It coalesces selected emails from the same conversation within one synchronization run into the newest incoming message. Older messages remain available through thread history. Use durable state in production; in-memory state is only suitable for local experiments.

The selected label controls dispatch, not OAuth access to the mailbox. `thread.post()` sends email immediately. Streaming buffers text and sends once; sent email cannot be edited or retracted. Bridges that implement their own post/edit streaming must disable that behavior for email.

## setup

1. Enable the Gmail API and Pub/Sub in your Google Cloud project. Obtain user-context OAuth credentials for the mailbox. Request `gmail.readonly` for reading and watches, plus `gmail.send` for replies. Draft creation needs `gmail.compose`. The adapter does not need permission to delete email or modify labels. See [Gmail scopes](https://developers.google.com/workspace/gmail/api/auth/scopes).
2. Create a Pub/Sub topic in the same Google Cloud project as the OAuth client. Grant `gmail-api-push@system.gserviceaccount.com` permission to publish to that topic.
3. Create an authenticated, wrapped Pub/Sub push subscription. Set the webhook URL as its audience and configure a push service account. This account is distinct from Gmail's publisher account. The Pub/Sub service agent needs permission to mint an identity token for it. Follow [Google's authenticated push setup](https://docs.cloud.google.com/pubsub/docs/authenticate-push-subscriptions).
4. Create a handoff label in Gmail and retrieve its ID with `listGmailLabels(options)` from `/api`, which uses [users.labels.list](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.labels/list). The label's display name is not its ID.
5. Configure the adapter, initialize Chat and register the watch. Renew the watch daily and run `gmail.sync()` periodically so dropped notifications do not leave the mailbox stale.

| config | environment |
| --- | --- |
| `mailbox` | `GMAIL_MAILBOX` |
| `labelId` | `GMAIL_LABEL_ID` |
| `clientId` | `GMAIL_CLIENT_ID` |
| `clientSecret` | `GMAIL_CLIENT_SECRET` |
| `refreshToken` | `GMAIL_REFRESH_TOKEN` |
| `accessToken` | `GMAIL_ACCESS_TOKEN` |
| `pubsubAudience` | `GMAIL_PUBSUB_AUDIENCE` |
| `pubsubServiceAccountEmail` | `GMAIL_PUBSUB_SERVICE_ACCOUNT_EMAIL` |
| `subscription` | `GMAIL_SUBSCRIPTION` |
| `topicName` | `GMAIL_TOPIC_NAME` |

Use either the OAuth client/refresh-token configuration or `accessToken`. A token resolver is recommended when another system already manages refresh. Explicit OAuth configuration takes precedence over an environment access token. The mailbox is an email address, the subscription is `projects/PROJECT/subscriptions/SUBSCRIPTION`, and the topic is `projects/PROJECT/topics/TOPIC`.

```typescript
await bot.initialize();
await gmail.watch();
```

Expose `bot.webhooks.gmail(request)` from your POST route. The adapter acknowledges only after synchronization completes. The application owns scheduling; importing the package does not start a worker. Stopping the application does not unregister the mailbox watch. Call `stopGmailMailbox(options)` from `/api` when disconnecting the mailbox permanently. This uses [users.stop](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users/stop), which stops mailbox notifications, not just notifications for the selected label. Stop renewal and sync jobs too; this call does not delete application state or revoke OAuth consent.

Google recommends daily renewal and requires renewal at least every seven days. A watch can emit a notification immediately, so the route must already be available. See [push delivery and renewal](https://developers.google.com/workspace/gmail/api/guides/push).

## delivery semantics

- Initial watch registration starts from Google's returned cursor, not the existing inbox. Renewal preserves the saved cursor. Expired history triggers a scan of currently labelled messages; this can include older labelled email that has never been dispatched.
- [Gmail labels belong to messages](https://developers.google.com/workspace/gmail/api/guides/labels). Applying a conversation label affects its existing messages. Future replies do not inherit the label. Label those replies explicitly or use a Gmail filter; subscribing to a Chat thread does not change Gmail's labels.
- Sent messages, drafts, spam and trash are excluded. Label checks happen before body retrieval and again before dispatch. Notifications are hints to read history, not message contents or trusted cursor updates.
- Durable receipts suppress previously dispatched and superseded messages. Coalescing is per synchronization run, not a guarantee of one callback per human UI action. Removing and reapplying a label does not replay a message already recorded as handled.
- Oversized responses and MIME parser failures are recorded separately as failed messages. Later conversations continue syncing; the adapter does not fall back to an older selected email from the failed conversation. Failed messages are not automatically fetched again, including during expired-history recovery.
- A rejected Chat handoff is also recorded as failed, not delivered. The adapter logs the native message ID, thread ID and a reason (`size`, `format` or `handler`) without including message content in that failure log. Chat's own logging configuration still applies. Monitor these errors and use the native IDs to inspect or recover the affected email explicitly.
- Chat's deduplication and concurrency semantics still apply. Failed handlers are not automatically replayed, since a handler might already have sent email before throwing. Persist application work and manage retries explicitly; use the primitives when the application owns its delivery pipeline. Removing and reapplying the label does not retry a recorded failure.
- Authentication, rate-limit and network errors during mailbox reads, and errors persisting synchronization state, still stop synchronization without advancing its cursor. A successful webhook acknowledgment means the changes have been accounted for, including recorded failures, not that every application handler succeeded.
- Sending is not transactional with state updates. A timeout or process failure can leave the sending outcome uncertain. Reconcile before retrying a send; neither the adapter nor Gmail's acceptance response proves final recipient delivery.
- MIME input and output are capped at 25 MiB by this package, with a 1 MiB buffered-stream text cap. These are local safety limits, not Gmail account or attachment quota claims.

The adapter does not implement an in-Gmail button, domain-wide deployment, reply-all, outbound delivery tracking, or approval UI. Email headers and content must not be treated as authorization for privileged tools.

## OAuth deployment

Mailbox-read access is a restricted scope. Production deployments must assess Google's verification and security-assessment requirements, including applicable exceptions for internal or test applications. Keep token material and email content out of logs, and apply appropriate retention and deletion policies to application state. See [restricted-scope verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification) and the [Workspace API data policy](https://developers.google.com/workspace/workspace-api-user-data-developer-policy).

## verification

Local tests exercise MIME, native API contracts, JWT verification, synchronization, Chat dispatch and import boundaries. A subprocess blocks Chat runtime imports while using the built primitive exports. Source and generated declaration graphs are checked separately. The authenticated integration test uses locally generated keys and mocked Gmail responses, not real Google credentials.

Live Gmail payload capture, end-to-end mailbox testing, catalog registration and release setup remain outstanding. This README describes the local design, not a released integration.

## Google references

- [Sending messages](https://developers.google.com/workspace/gmail/api/guides/sending)
- [Reply threading requirements](https://developers.google.com/workspace/gmail/api/guides/threads)
- [Mailbox push notifications and watch renewal](https://developers.google.com/workspace/gmail/api/guides/push)
- [History synchronization and expired cursors](https://developers.google.com/workspace/gmail/api/guides/sync)
- [Authenticated Pub/Sub delivery](https://docs.cloud.google.com/pubsub/docs/authenticate-push-subscriptions)
- [OAuth scopes](https://developers.google.com/workspace/gmail/api/auth/scopes)

## AI Coding Agents

Install the Chat SDK skill with `npx skills add vercel/chat`. Agent-readable documentation is available at [llms.txt](https://chat-sdk.dev/llms.txt) and [llms-full.txt](https://chat-sdk.dev/llms-full.txt).
