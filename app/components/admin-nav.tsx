import { useModeration } from "~/lib/use-moderation";

import { LinkTabs } from "./ui/tabs";

/** The moderation pages' title and tabs, with the queue's size. */
export function AdminHeader({ current }: { current: "/admin" | "/admin/users" | "/admin/log" | "/admin/settings" }) {
  const moderation = useModeration();
  const open = moderation?.openReports ?? 0;
  return (
    <div className="space-y-3">
      <h1 className="text-display font-semibold">Moderation</h1>
      <LinkTabs
        label="Moderation"
        current={current}
        tabs={[
          { label: open > 0 ? `Reports · ${open}` : "Reports", to: "/admin" },
          { label: "Users", to: "/admin/users" },
          { label: "Log", to: "/admin/log" },
          { label: "Settings", to: "/admin/settings" },
        ]}
      />
    </div>
  );
}
