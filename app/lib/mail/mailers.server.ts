import { env } from "cloudflare:workers";

import { deliverable } from "./address";

/** One email, as the board writes it, whichever service sends it. */
export interface Mail {
  from: { name: string; email: string };
  to: string;
  subject: string;
  html: string;
  text: string;
  headers?: Record<string, string>;
}

/** What sends mail: Cloudflare's binding, Amazon SES, or a test's stand-in. */
export interface Mailer {
  send(mail: Mail): Promise<unknown>;
}

/** Hands mail on, except to an address that cannot reach anyone. */
function guarded(send: (mail: Mail) => Promise<unknown>): Mailer {
  return { send: async (mail) => (deliverable(mail.to) ? send(mail) : null) };
}

/**
 * Cloudflare's Email Sending, for the mail an account needs or asked for:
 * the digest, sign-in links, and notices about the account. Cloudflare
 * takes transactional mail only, so never offers.
 */
export function accountMailer(binding: SendEmail = env.EMAIL): Mailer {
  return guarded((mail) => binding.send(mail));
}

/** Whether Amazon SES is set up here, for offers. */
export function offersMailerConfigured(): boolean {
  return Boolean(env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY);
}

/**
 * Amazon SES, for offers to members who said yes to them: marketing mail,
 * which Cloudflare's Email Sending does not carry. Null where SES is not
 * set up, and then no offer is sent.
 */
export function offersMailer(): Mailer | null {
  const accessKeyId = env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = env.AWS_SECRET_ACCESS_KEY;
  if (!accessKeyId || !secretAccessKey) return null;
  const region = env.AWS_REGION || "us-east-1";
  return guarded((mail) => sendWithSes({ accessKeyId, secretAccessKey, region }, mail));
}

const encoder = new TextEncoder();

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256(text: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", encoder.encode(text)));
}

async function hmac(key: ArrayBuffer, text: string): Promise<ArrayBuffer> {
  const imported = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", imported, encoder.encode(text));
}

/** A subject SES takes: 7-bit ASCII as it is, anything else as an RFC 2047 encoded word. */
export function sesSubject(subject: string): string {
  // eslint-disable-next-line no-control-regex
  if (/^[\x00-\x7f]*$/.test(subject)) return subject;
  const bytes = encoder.encode(subject);
  return `=?UTF-8?B?${btoa(String.fromCharCode(...bytes))}?=`;
}

/** The "Name <address>" form, with the name quoted. */
function mailbox(from: Mail["from"]): string {
  return `"${from.name.replace(/["\\]/g, "")}" <${from.email}>`;
}

/**
 * Sends through SES's v2 API, signed with AWS Signature Version 4, so the
 * Worker carries no SDK.
 */
async function sendWithSes(
  credentials: { accessKeyId: string; secretAccessKey: string; region: string },
  mail: Mail,
): Promise<void> {
  const { accessKeyId, secretAccessKey, region } = credentials;
  const url = new URL(`https://email.${region}.amazonaws.com/v2/email/outbound-emails`);
  const body = JSON.stringify({
    FromEmailAddress: mailbox(mail.from),
    Destination: { ToAddresses: [mail.to] },
    Content: {
      Simple: {
        Subject: { Data: sesSubject(mail.subject), Charset: "UTF-8" },
        Body: { Html: { Data: mail.html, Charset: "UTF-8" }, Text: { Data: mail.text, Charset: "UTF-8" } },
        Headers: Object.entries(mail.headers ?? {}).map(([Name, Value]) => ({ Name, Value })),
      },
    },
  });
  const amzDate = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
  const day = amzDate.slice(0, 8);
  const payloadHash = await sha256(body);
  const signedHeaders = "content-type;host;x-amz-content-sha256;x-amz-date";
  const canonical = [
    "POST",
    url.pathname,
    "",
    `content-type:application/json\nhost:${url.host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`,
    signedHeaders,
    payloadHash,
  ].join("\n");
  const scope = `${day}/${region}/ses/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, await sha256(canonical)].join("\n");
  let key = await hmac(encoder.encode(`AWS4${secretAccessKey}`).buffer as ArrayBuffer, day);
  for (const part of [region, "ses", "aws4_request"]) key = await hmac(key, part);
  const signature = hex(await hmac(key, toSign));
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Amz-Date": amzDate,
      "X-Amz-Content-Sha256": payloadHash,
      Authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
    body,
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`SES answered ${response.status}: ${(await response.text()).slice(0, 300)}`);
}
