import { env } from "cloudflare:workers";

import { FRESH_START_PRICE, INTRO_PRICES, NAME_ALLOWANCES, PLAN_PRICES } from "../plan";
import { portalConfigurationFor, stripeClient } from "./stripe";

/** One line of a check: what was looked at, whether it is right, and what was found. */
export interface Check {
  label: string;
  ok: boolean;
  detail: string;
}

const EXPECTED = [
  { ...PLAN_PRICES.month, interval: "month" },
  { ...PLAN_PRICES.year, interval: "year" },
  { ...INTRO_PRICES.month, interval: "month" },
  { ...INTRO_PRICES.year, interval: "year" },
  { ...FRESH_START_PRICE, interval: null },
  ...Object.values(NAME_ALLOWANCES).map((price) => ({ ...price, interval: null })),
];

function failure(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Whether payments can work in this environment, for an admin to read:
 * the Stripe key's mode (never the key), each price the board looks up by
 * its lookup key, the portal configuration for a new member's prices, and
 * the webhook's secret. Each Stripe answer, or its error, as it came.
 */
export async function paymentChecks(): Promise<Check[]> {
  const key = env.STRIPE_SECRET_KEY;
  if (!key) return [{ label: "Stripe key", ok: false, detail: "Not set, so payments are closed." }];
  const shape = /^(sk|rk)_(test|live)_/.exec(key);
  const checks: Check[] = [
    {
      label: "Stripe key",
      ok: shape !== null,
      detail: shape
        ? `${shape[2] === "live" ? "Live" : "Test"} mode, ${shape[1] === "rk" ? "a restricted key" : "a secret key"}.`
        : "Not a Stripe secret or restricted key.",
    },
    {
      label: "Webhook secret",
      ok: Boolean(env.STRIPE_WEBHOOK_SECRET),
      detail: env.STRIPE_WEBHOOK_SECRET ? "Set." : "Not set: Stripe's events are refused.",
    },
  ];
  const client = stripeClient(key);
  try {
    const { data } = await client.request<{
      data: Array<{ lookup_key: string | null; unit_amount: number | null; currency: string; recurring: { interval: string } | null }>;
    }>("GET", "/prices", { lookup_keys: EXPECTED.map((price) => price.lookupKey), active: true, limit: 10 });
    for (const expected of EXPECTED) {
      const found = data.find((price) => price.lookup_key === expected.lookupKey);
      const right =
        found !== undefined &&
        found.unit_amount === expected.cents &&
        found.currency === "usd" &&
        (found.recurring?.interval ?? null) === expected.interval;
      checks.push({
        label: `Price ${expected.lookupKey}`,
        ok: right,
        detail: found
          ? `${(found.unit_amount ?? 0) / 100} ${found.currency.toUpperCase()}${found.recurring ? ` a ${found.recurring.interval}` : ", once"}${right ? "" : `; expected ${expected.label}${expected.interval ? ` a ${expected.interval}` : ", once"}`}.`
          : "No active price has this lookup key.",
      });
    }
  } catch (error) {
    checks.push({ label: "Prices", ok: false, detail: failure(error) });
  }
  try {
    const intro = await portalConfigurationFor(client, "intro");
    checks.push({
      label: "Portal for a new member's prices",
      ok: intro !== null,
      detail: intro ? "Found." : "No active configuration has the metadata aionly_prices=intro.",
    });
  } catch (error) {
    checks.push({ label: "Portal", ok: false, detail: failure(error) });
  }
  return checks;
}
