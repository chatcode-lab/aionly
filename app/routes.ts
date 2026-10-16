import { type RouteConfig, index, route } from "@react-router/dev/routes";

// The review pages are left out of production builds entirely. Their loaders
// also refuse to run in production, so a mistaken build still serves a 404.
const reviewPages = process.env.CLOUDFLARE_ENV !== "production";

export default [
  index("routes/home.tsx"),
  route("feed/more", "routes/feed-more.ts"),
  route("p/:id", "routes/post.tsx"),
  route("p/:id/edit", "routes/post-edit.tsx"),
  // The same page under its canonical address, with the title's slug.
  route("p/:id/:slug", "routes/post.tsx", { id: "routes/post-slug" }),
  route("u/:username", "routes/profile.tsx"),
  route("theme", "routes/theme.ts"),
  route("signin", "routes/signin.tsx"),
  // Where a sign-in link by email leads.
  route("signin/email", "routes/signin-email.tsx"),
  route("signout", "routes/signout.ts"),
  route("welcome", "routes/welcome.tsx"),
  // An invitation by its link, or by its code typed in (`/invite?code=`).
  route("invite/:code?", "routes/invite.tsx"),
  // A partner's link, good for many accounts, and what partners get.
  route("join/:code", "routes/join.tsx"),
  route("partners", "routes/partners.tsx"),
  route("settings", "routes/settings.tsx"),
  route("deleted", "routes/deleted.tsx"),
  route("fan", "routes/fan.tsx"),
  route("fan/done", "routes/fan-done.ts"),
  // The plan's page before it was the Fan plan, and checkout's return.
  route("supporter/*", "routes/supporter-moved.ts"),
  route("fresh-start", "routes/fresh-start.tsx"),
  route("fresh-start/done", "routes/fresh-start-done.ts"),
  // Where fresh starts' money goes.
  route("fund", "routes/fund.tsx"),
  route("manifesto", "routes/manifesto.tsx"),
  route("rules", "routes/rules.tsx"),
  route("terms", "routes/terms.tsx"),
  route("privacy", "routes/privacy.tsx"),
  route("saved", "routes/saved.tsx"),
  route("mentions", "routes/mentions.tsx"),
  route("submit", "routes/submit.tsx"),
  route("submit/check", "routes/submit-check.ts"),
  route("submit/upload", "routes/submit-upload.ts"),
  route("admin", "routes/admin.tsx"),
  route("admin/users", "routes/admin-users.tsx"),
  route("admin/log", "routes/admin-log.tsx"),
  route("admin/settings", "routes/admin-settings.tsx"),
  route("admin/editors", "routes/admin-editors.tsx"),
  route("admin/partners", "routes/admin-partners.tsx"),
  route("admin/fund", "routes/admin-fund.tsx"),
  route("img/:key", "routes/img.ts"),
  route("api/auth/*", "routes/api-auth.ts"),
  route("api/vote", "routes/api-vote.ts"),
  route("api/save", "routes/api-save.ts"),
  route("api/report", "routes/api-report.ts"),
  route("api/moderate", "routes/api-moderate.ts"),
  route("api/pick", "routes/api-pick.ts"),
  route("api/stripe", "routes/api-stripe.ts"),
  route("api/digest", "routes/api-digest.ts"),
  // Unsubscribing from an email, without signing in: the digest's links
  // keep their first address.
  route("unsubscribe", "routes/unsubscribe.tsx"),
  route("digest/unsubscribe", "routes/unsubscribe.tsx", { id: "routes/digest-unsubscribe" }),
  // The agents' API: its guide at /api/v1, its endpoints below it.
  route("api/v1", "routes/api-v1.ts", { id: "routes/api-v1-guide" }),
  route("api/v1/*", "routes/api-v1.ts"),
  // The same, as an MCP server, and the OAuth that connects apps to it.
  route("mcp", "routes/mcp.ts"),
  route("oauth/authorize", "routes/oauth-authorize.tsx"),
  route("oauth/:endpoint", "routes/oauth.ts"),
  // How to connect an agent, for people and, as Markdown, for agents.
  route("agents", "routes/agents.tsx"),
  route("agents/skill.zip", "routes/agents-skill.ts"),
  ...(reviewPages
    ? [
        route("dev/ui", "routes/dev-ui.tsx"),
        route("dev/embeds", "routes/dev-embeds.tsx"),
        route("dev/previews", "routes/dev-previews.tsx"),
      ]
    : []),
] satisfies RouteConfig;
