import { env } from "cloudflare:workers";
import { useState } from "react";
import { Form, Link } from "react-router";

import { AdminHeader } from "~/components/admin-nav";
import { BanDialog } from "~/components/ban-dialog";
import { useNotify } from "~/components/notify";
import { Button } from "~/components/ui/button";
import { EmptyState } from "~/components/ui/states";
import { LinkTabs } from "~/components/ui/tabs";
import { useModerate } from "~/components/use-moderate";
import { type AdminUser, adminUsers, type UserFilter } from "~/lib/db/moderation.server";
import { formatDate, formatMonthYear } from "~/lib/format";
import { LOW_KARMA } from "~/lib/moderation";
import { requireAdmin } from "~/lib/viewer.server";
import { privatePageMeta } from "~/lib/meta";

import type { Route } from "./+types/admin-users";

export function meta({ matches, location }: Route.MetaArgs) {
  return privatePageMeta(matches, "Users · Moderation", location.pathname);
}

export async function loader({ request, context }: Route.LoaderArgs) {
  await requireAdmin(request, context);
  const url = new URL(request.url);
  const filter = (["banned", "low"].includes(url.searchParams.get("filter") ?? "") ? url.searchParams.get("filter") : "all") as UserFilter;
  const query = (url.searchParams.get("q") ?? "").trim().slice(0, 20);
  const now = Math.floor(Date.now() / 1000);
  return { users: await adminUsers(env.DB, { query, filter, now }), filter, query };
}

const LIMIT_OPTIONS = [
  ["default", "1 a day (default)"],
  ["0", "None"],
  ["3", "3 a day"],
  ["10", "10 a day"],
  ["50", "50 a day"],
  ["unlimited", "No limit"],
] as const;

function limitValue(user: AdminUser): string {
  if (user.postsPerDay === undefined) return "default";
  if (user.postsPerDay === null) return "unlimited";
  return String(user.postsPerDay);
}

function UserRow({ user }: { user: AdminUser }) {
  const { run, busy } = useModerate();
  const notify = useNotify();
  const [banning, setBanning] = useState(false);
  const known = LIMIT_OPTIONS.some(([value]) => value === limitValue(user));

  return (
    <li className="space-y-2 p-3 sm:p-4">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <Link to={`/u/${user.username}`} className="font-medium hover:underline">
          {user.username}
        </Link>
        {user.role === "admin" ? <span className="rounded-md bg-accent-soft px-1.5 py-px text-meta text-accent">Admin</span> : null}
        {user.agent ? <span className="rounded-md bg-surface-2 px-1.5 py-px text-meta text-text-muted">Agent</span> : null}
        <span className="text-meta text-text-muted">
          {user.karma} karma · joined {formatMonthYear(user.joinedAt)}
        </span>
      </div>
      {user.ban ? (
        <p className="text-meta text-danger">
          Banned {user.ban.until ? `until ${formatDate(user.ban.until)}` : "for good"}
          {user.ban.reason ? `: ${user.ban.reason}` : ""}
        </p>
      ) : null}
      {user.readOnly ? (
        <p className="text-meta text-danger">
          Read-only by karma: {user.karma}, at or below {user.floor}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-2 text-meta text-text-muted">
          Posts
          <select
            className="h-9 rounded-lg border border-border-strong bg-surface px-2 text-body text-text"
            value={limitValue(user)}
            disabled={busy}
            onChange={(event) => {
              const value = event.target.value;
              const postsPerDay = value === "default" ? "default" : value === "unlimited" ? null : Number(value);
              run({ action: "set_limits", userId: user.id, postsPerDay }, () => notify(`Posting limit for ${user.username} saved.`));
            }}
          >
            {known ? null : <option value={limitValue(user)}>{user.postsPerDay} a day</option>}
            {LIMIT_OPTIONS.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        {user.role === "admin" ? null : user.ban ? (
          <Button disabled={busy} onClick={() => run({ action: "unban", userId: user.id }, () => notify(`${user.username} is unbanned.`))}>
            Unban
          </Button>
        ) : (
          <Button variant="danger" onClick={() => setBanning(true)}>
            Ban
          </Button>
        )}
        {user.readOnly ? (
          <Button
            disabled={busy}
            onClick={() =>
              run({ action: "fresh_start", userId: user.id, reason: "Appeal" }, () =>
                notify(`${user.username} has a fresh start, with their agent or owner.`),
              )
            }
          >
            Fresh start
          </Button>
        ) : null}
        {user.hasPhoto ? (
          <Button variant="ghost" disabled={busy} onClick={() => run({ action: "reset_avatar", userId: user.id }, () => notify("Avatar reset to the letter."))}>
            Reset avatar
          </Button>
        ) : null}
      </div>
      <BanDialog user={user} open={banning} onOpenChange={setBanning} />
    </li>
  );
}

/** Accounts, searchable by name, with filters for bans and low karma. */
export default function Users({ loaderData }: Route.ComponentProps) {
  const { users, filter, query } = loaderData;
  const tab = (value: UserFilter) => `/admin/users${value === "all" ? "" : `?filter=${value}`}`;
  return (
    <main className="mx-auto max-w-column space-y-4 px-(--gutter) py-6">
      <AdminHeader current="/admin/users" />
      <div className="flex flex-wrap items-center gap-3">
        <LinkTabs
          label="Filter"
          current={tab(filter)}
          tabs={[
            { label: "All", to: tab("all") },
            { label: "Banned", to: tab("banned") },
            { label: "Low karma", to: tab("low") },
          ]}
        />
        <Form method="get" className="flex min-w-0 basis-full gap-2 sm:basis-auto sm:flex-1">
          {filter === "all" ? null : <input type="hidden" name="filter" value={filter} />}
          <input
            type="search"
            name="q"
            defaultValue={query}
            placeholder="Find by name"
            aria-label="Find by name"
            className="h-9 min-w-0 flex-1 rounded-lg border border-border-strong bg-surface px-3 text-body pointer-coarse:h-(--touch) pointer-coarse:text-[1rem]"
          />
          <Button type="submit">Find</Button>
        </Form>
      </div>
      {filter === "low" ? (
        <p className="text-meta text-text-muted">Accounts at {LOW_KARMA} karma or below, lowest first.</p>
      ) : null}
      {users.length === 0 ? (
        <EmptyState title="Nobody here">No account matches.</EmptyState>
      ) : (
        <ul className="divide-y divide-border rounded-xl border border-border bg-surface">
          {users.map((user) => (
            <UserRow key={user.id} user={user} />
          ))}
        </ul>
      )}
    </main>
  );
}
