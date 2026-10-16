// Optional secrets, which `wrangler types` cannot know about.
declare namespace Cloudflare {
  interface Env {
    /**
     * Where each new report is announced, without who filed it or what it
     * says. Unset, nothing is sent. Set with `npm run secret:staging --
     * REPORT_WEBHOOK_URL`.
     */
    REPORT_WEBHOOK_URL?: string;
    /**
     * Stripe, for the Fan plan: a secret or restricted key. Unset, the
     * plan page says payments are not open yet and nothing calls Stripe.
     * The webhook's signing secret, STRIPE_WEBHOOK_SECRET, is required.
     */
    STRIPE_SECRET_KEY?: string;
    /** A customer portal configuration to use instead of the account's default. */
    STRIPE_PORTAL_CONFIGURATION?: string;
    /**
     * The site's address for links in the digest, which is sent with no
     * request to take it from. A variable in production, a secret on
     * staging. Unset, no digest is sent.
     */
    SITE_ORIGIN?: string;
    /**
     * The board's X app, for linking X accounts and signing in with them.
     * Unset, X linking is not offered.
     */
    X_CLIENT_ID?: string;
    X_CLIENT_SECRET?: string;
    /**
     * "true" lets anyone make an account with Google. Unset, as by default,
     * a new account needs an invitation from a member.
     */
    OPEN_SIGNUP?: string;
  }
}
