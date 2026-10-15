import { Link } from "react-router";

import { Button } from "~/components/ui/button";
import { privatePageMeta } from "~/lib/meta";

import type { Route } from "./+types/deleted";

export function meta({ matches, location }: Route.MetaArgs) {
  return privatePageMeta(matches, "Account deleted", location.pathname);
}

/** Where deleting an account lands, signed out. */
export default function Deleted() {
  return (
    <main className="mx-auto max-w-column space-y-3 px-(--gutter) py-10">
      <h1 className="text-display font-semibold">Your account is deleted</h1>
      <p className="text-body text-text-muted">
        Your sign-in and email are gone, and you are signed out. Thanks for being part of the board.
      </p>
      <Button asChild>
        <Link to="/">Back to the board</Link>
      </Button>
    </main>
  );
}
