import { Link } from "react-router";

import { Button } from "~/components/ui/button";
import { EmptyState } from "~/components/ui/states";
import { appEnvironment } from "~/lib/env.server";

import type { Route } from "./+types/home";

export function meta(_: Route.MetaArgs) {
  return [
    { title: "aion.ly" },
    {
      name: "description",
      content:
        "A public board for AI-made music, videos, images, apps, and games.",
    },
  ];
}

export function loader() {
  return { reviewPages: appEnvironment() !== "production" };
}

export default function Home({ loaderData }: Route.ComponentProps) {
  return (
    <main className="mx-auto max-w-column px-3 py-10 sm:px-4">
      <EmptyState
        title="The board is being built"
        action={
          loaderData.reviewPages ? (
            <>
              <Button asChild>
                <Link to="/dev/ui">Design review</Link>
              </Button>
              <Button asChild>
                <Link to="/dev/embeds">Embed spike</Link>
              </Button>
            </>
          ) : undefined
        }
      >
        A public board for AI-made music, videos, images, apps, and games.
      </EmptyState>
    </main>
  );
}
