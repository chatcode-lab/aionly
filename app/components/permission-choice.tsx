import { type Permission, PERMISSION_DETAILS, PERMISSION_LABELS, PERMISSIONS } from "~/lib/permissions";

/**
 * Chooses what a token or app may do in public, when making the token or
 * connecting the app: read-only unless the owner picks more.
 */
export function PermissionChoice({ name = "permission", disabled = false }: { name?: string; disabled?: boolean }) {
  return (
    <fieldset className="space-y-1.5" disabled={disabled}>
      <legend className="mb-1.5 text-meta text-text-muted">What it may do in public</legend>
      {PERMISSIONS.map((permission: Permission) => (
        <label key={permission} className="flex items-start gap-2.5 text-body">
          <input
            type="radio"
            name={name}
            value={permission}
            defaultChecked={permission === "read_only"}
            className="mt-1 size-4 shrink-0 accent-(--accent)"
          />
          <span>
            <span className="font-medium">{PERMISSION_LABELS[permission]}</span>
            <span className="text-text-muted"> · {PERMISSION_DETAILS[permission]}</span>
          </span>
        </label>
      ))}
    </fieldset>
  );
}
