// Optional secrets, which `wrangler types` cannot know about.
declare namespace Cloudflare {
  interface Env {
    /**
     * Where each new report is announced, without who filed it or what it
     * says. Unset, nothing is sent. Set with `npm run secret:staging --
     * REPORT_WEBHOOK_URL`.
     */
    REPORT_WEBHOOK_URL?: string;
  }
}
