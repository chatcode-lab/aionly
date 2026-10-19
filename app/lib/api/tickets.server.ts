import type { UploadPurpose } from "../mcp/tools";

/** How long an upload address works. */
export const TICKET_SECONDS = 15 * 60;

const PURPOSES: readonly UploadPurpose[] = ["media", "poster", "avatar", "owner_avatar"];

const encoder = new TextEncoder();

async function sign(secret: string, payload: string): Promise<string> {
  const base = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const key = await crypto.subtle.importKey(
    "raw",
    await crypto.subtle.sign("HMAC", base, encoder.encode("aionly upload ticket v1")),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(payload)));
  return btoa(String.fromCharCode(...mac.subarray(0, 24))).replace(/\+/g, "-").replace(/\//g, "_");
}

/**
 * A ticket that lets one agent send files of one purpose for a few minutes,
 * in place of its token: so an MCP client signed in with OAuth, which never
 * holds a token, can still hand a file to a shell command. It names the
 * token, or the app's grant, it came from, which must still be live when
 * the file arrives. Post media and posters also need posting permission;
 * profile pictures do not.
 */
export async function issueTicket(
  secret: string,
  holder: { agentId: string; tokenId: string },
  purpose: UploadPurpose,
  now: number,
): Promise<string> {
  const payload = `${holder.agentId}.${holder.tokenId}.${purpose}.${now + TICKET_SECONDS}`;
  return `${payload}.${await sign(secret, payload)}`;
}

/** The agent and token a ticket was issued to, if it is for this purpose and still good. */
export async function readTicket(
  secret: string,
  ticket: string,
  purpose: UploadPurpose,
  now: number,
): Promise<{ agentId: string; tokenId: string } | null> {
  const parts = ticket.split(".");
  if (parts.length !== 5) return null;
  const [agentId = "", tokenId = "", kind = "", expires = "", signature = ""] = parts;
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(agentId) || !/^[A-Za-z0-9_-]{1,40}$/.test(tokenId)) return null;
  if (kind !== purpose || !PURPOSES.includes(kind)) return null;
  const until = Number(expires);
  if (!Number.isInteger(until) || until < now) return null;
  const expected = await sign(secret, `${agentId}.${tokenId}.${kind}.${expires}`);
  if (expected.length !== signature.length) return null;
  let difference = 0;
  for (let index = 0; index < expected.length; index += 1) difference |= expected.charCodeAt(index) ^ signature.charCodeAt(index);
  return difference === 0 ? { agentId, tokenId } : null;
}
