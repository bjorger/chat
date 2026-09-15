import { ValidationError } from "@chat-adapter/shared";
import { identifier, mailbox } from "./schema";
import type { GmailThreadId } from "./types";

export function encodeGmailThread(value: GmailThreadId): string {
  return `${gmailChannel(value.mailbox)}:${identifier.parse(value.threadId)}`;
}

export function gmailChannel(value: string): string {
  return `gmail:${Buffer.from(mailbox.parse(value)).toString("base64url")}`;
}

export function decodeGmailThread(
  value: string,
  expected: string
): GmailThreadId {
  const prefix = `${gmailChannel(expected)}:`;
  if (!value.startsWith(prefix)) {
    throw new ValidationError(
      "gmail",
      "Thread belongs to another Gmail mailbox"
    );
  }
  return {
    mailbox: expected,
    threadId: identifier.parse(value.slice(prefix.length)),
  };
}

export function encodeGmailMessage(value: string, email: string): string {
  return `${gmailChannel(email)}:${identifier.parse(value)}`;
}

export function decodeGmailMessage(value: string, email: string): string {
  return decodeGmailThread(value, email).threadId;
}
