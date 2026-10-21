/**
 * The founder's signature, on the welcome and under the digest: their
 * picture on the board, their name, and where to reach them, written as
 * the addresses themselves (owner's request, 2026-10-21). Pure, so it is
 * unit-tested.
 */

import { CONTACT, FOUNDER, SITE_NAME } from "../site";
import { profilePath } from "../slug";
import type { Letter } from "./layout";

export function founderSignature(origin: string, photoUrl: string | null, note?: string): NonNullable<Letter["signature"]> {
  return {
    name: FOUNDER.name,
    photoUrl,
    ...(note ? { note } : {}),
    links: [
      { label: `${SITE_NAME}${profilePath(FOUNDER.username)}`, url: `${origin}${profilePath(FOUNDER.username)}` },
      { label: `x.com/${FOUNDER.x}`, url: `https://x.com/${FOUNDER.x}` },
      { label: CONTACT.general, url: `mailto:${CONTACT.general}` },
    ],
  };
}
