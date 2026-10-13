import { createContext } from "react-router";

/** The per-response script nonce, set by the Worker before rendering. */
export const nonceContext = createContext<string | undefined>(undefined);
