import type { Logger } from "chat";
import type { GmailToken } from "./api";
import type { GmailEmail } from "./format";

export interface GmailAdapterConfig {
  accessToken?: GmailToken;
  clientId?: string;
  clientSecret?: string;
  fetch?: typeof globalThis.fetch;
  labelId?: string;
  logger?: Logger;
  mailbox?: string;
  pubsubAudience?: string;
  pubsubServiceAccountEmail?: string;
  refreshToken?: string;
  subscription?: string;
  topicName?: string;
}

export interface GmailThreadId {
  mailbox: string;
  threadId: string;
}

export type GmailRawMessage = GmailEmail;
