import { createContext } from "react-router";

import type { AccountRecord } from "./lib/db/accounts.server";

/** The per-response script nonce, set by the Worker before rendering. */
export const nonceContext = createContext<string | undefined>(undefined);

/**
 * The signed-in account for this request, looked up once on first use and
 * shared by every loader and action that asks. Null when signed out.
 */
export const viewerContext = createContext<() => Promise<AccountRecord | null>>(
  async () => null,
);

/** Keeps work going after the response is sent, such as a notification. */
export const waitUntilContext = createContext<(work: Promise<unknown>) => void>(() => {});
