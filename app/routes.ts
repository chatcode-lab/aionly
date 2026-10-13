import { type RouteConfig, index, route } from "@react-router/dev/routes";

// The review pages are left out of production builds entirely. Their loaders
// also refuse to run in production, so a mistaken build still serves a 404.
const reviewPages = process.env.CLOUDFLARE_ENV !== "production";

export default [
  index("routes/home.tsx"),
  route("theme", "routes/theme.ts"),
  route("embed/shell/:provider/:id", "routes/embed-shell.ts"),
  ...(reviewPages
    ? [
        route("dev/ui", "routes/dev-ui.tsx"),
        route("dev/embeds", "routes/dev-embeds.tsx"),
      ]
    : []),
] satisfies RouteConfig;
