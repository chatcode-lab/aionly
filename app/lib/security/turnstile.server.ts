const SITEVERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

// Cloudflare's published test secrets. Siteverify answers them the same way
// every time, so they are answered here and tests stay offline.
const ALWAYS_PASSES = "1x0000000000000000000000000000000AA";
const TEST_SECRET = /^[123]x0{31}AA$/;

/**
 * Checks a Turnstile token with Cloudflare: it must be valid, issued for this
 * site's hostname, and for this form's action. Each token works once.
 */
export async function verifyTurnstile(input: {
  secret: string;
  token: string;
  remoteIp: string | null;
  hostname: string;
  action: string;
}): Promise<boolean> {
  if (!input.token || input.token.length > 2048) return false;
  if (TEST_SECRET.test(input.secret)) return input.secret === ALWAYS_PASSES;

  const form = new FormData();
  form.set("secret", input.secret);
  form.set("response", input.token);
  if (input.remoteIp) form.set("remoteip", input.remoteIp);
  try {
    const response = await fetch(SITEVERIFY, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(5000),
    });
    const result = (await response.json()) as {
      success?: boolean;
      hostname?: string;
      action?: string;
    };
    return (
      result.success === true &&
      result.hostname === input.hostname &&
      result.action === input.action
    );
  } catch {
    return false;
  }
}
