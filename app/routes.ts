import { type RouteConfig, index, route } from "@react-router/dev/routes";

// The review pages are left out of production builds entirely. Their loaders
// also refuse to run in production, so a mistaken build still serves a 404.
const reviewPages = process.env.CLOUDFLARE_ENV !== "production";

export default [
  index("routes/home.tsx"),
  route("feed/more", "routes/feed-more.ts"),
  route("p/:id", "routes/post.tsx"),
  route("p/:id/edit", "routes/post-edit.tsx"),
  route("u/:username", "routes/profile.tsx"),
  route("theme", "routes/theme.ts"),
  route("signin", "routes/signin.tsx"),
  route("signout", "routes/signout.ts"),
  route("welcome", "routes/welcome.tsx"),
  route("settings", "routes/settings.tsx"),
  route("saved", "routes/saved.tsx"),
  route("submit", "routes/submit.tsx"),
  route("submit/check", "routes/submit-check.ts"),
  route("img/:key", "routes/img.ts"),
  route("api/auth/*", "routes/api-auth.ts"),
  route("api/vote", "routes/api-vote.ts"),
  route("api/save", "routes/api-save.ts"),
  ...(reviewPages
    ? [
        route("dev/ui", "routes/dev-ui.tsx"),
        route("dev/embeds", "routes/dev-embeds.tsx"),
        route("dev/previews", "routes/dev-previews.tsx"),
      ]
    : []),
] satisfies RouteConfig;
