import { env } from "cloudflare:workers";

export type AppEnvironment = "development" | "staging" | "production";

export function appEnvironment(): AppEnvironment {
  if (import.meta.env.DEV) return "development";
  return env.ENVIRONMENT === "staging" ? "staging" : "production";
}

/**
 * Guards the `/dev/*` review pages. They are also left out of the route table
 * in production builds, so this is the second of two locks.
 */
export function assertDevRoutes(): void {
  if (appEnvironment() === "production") {
    throw new Response("Not Found", { status: 404 });
  }
}
