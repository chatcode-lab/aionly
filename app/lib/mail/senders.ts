import type { Frequency } from "../digest/frequency";
import { CONTACT, FOUNDER } from "../site";

/**
 * Who each kind of email comes from. A reply to any of them but a sign-in
 * link reaches a person, at the general address.
 */
export const SENDERS = {
  digest: { from: { name: "aion.ly", email: "digest@aion.ly" }, replyTo: CONTACT.general },
  offers: { from: { name: "aion.ly", email: "noreply@aion.ly" }, replyTo: CONTACT.general },
  /** The new member's welcome, from the founder in their own name, replies to the general address. */
  welcome: { from: { name: FOUNDER.name, email: CONTACT.general }, replyTo: CONTACT.general },
  notices: { from: { name: "aion.ly", email: "noreply@aion.ly" }, replyTo: CONTACT.general },
  signIn: { from: { name: "aion.ly", email: "noreply@aion.ly" } },
} as const;

/**
 * The digest's sender by its kind, "aion.ly daily", so an inbox says which
 * digest it is before its subject does (owner's request, 2026-10-29).
 */
export function digestSender(frequency: Frequency): string {
  return `${SENDERS.digest.from.name} ${frequency}`;
}
