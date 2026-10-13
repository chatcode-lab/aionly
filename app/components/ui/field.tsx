import { type ComponentProps, type ReactNode, useId } from "react";

import { cn } from "~/lib/cn";

// 16 px on touch screens stops iOS from zooming the page on focus.
const CONTROL =
  "w-full rounded-lg border bg-surface px-3 text-body text-text placeholder:text-text-faint pointer-coarse:text-[1rem]";

function controlBorder(invalid: boolean): string {
  return invalid ? "border-danger" : "border-border-strong";
}

interface FieldShellProps {
  label: string;
  hint?: string;
  error?: string;
  /** Current and maximum length; the counter turns red past the limit. */
  count?: { value: number; max: number };
}

function FieldShell({
  id,
  label,
  hint,
  error,
  count,
  children,
}: FieldShellProps & { id: string; children: ReactNode }) {
  const over = count ? count.value > count.max : false;
  return (
    <div>
      <label htmlFor={id} className="block text-body font-medium">
        {label}
      </label>
      {hint ? (
        <p id={`${id}-hint`} className="mt-0.5 text-meta text-text-muted">
          {hint}
        </p>
      ) : null}
      <div className="mt-1.5">{children}</div>
      <div className="mt-1 flex min-h-[1.125rem] justify-between gap-4 text-meta">
        <p id={`${id}-error`} role="alert" className="text-danger">
          {error}
        </p>
        {count ? (
          <p
            className={cn(
              "shrink-0 tabular-nums",
              over ? "text-danger" : "text-text-faint",
            )}
          >
            {count.value}/{count.max}
          </p>
        ) : null}
      </div>
    </div>
  );
}

function describedBy(id: string, hint?: string, error?: string) {
  const ids = [hint && `${id}-hint`, error && `${id}-error`].filter(Boolean);
  return ids.length > 0 ? ids.join(" ") : undefined;
}

export function TextField({
  label,
  hint,
  error,
  count,
  className,
  ...props
}: FieldShellProps & ComponentProps<"input">) {
  const id = useId();
  return (
    <FieldShell id={id} label={label} hint={hint} error={error} count={count}>
      <input
        id={id}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(id, hint, error)}
        className={cn(
          CONTROL,
          "h-10 pointer-coarse:h-11",
          controlBorder(Boolean(error)),
          className,
        )}
        {...props}
      />
    </FieldShell>
  );
}

export function TextArea({
  label,
  hint,
  error,
  count,
  className,
  ...props
}: FieldShellProps & ComponentProps<"textarea">) {
  const id = useId();
  return (
    <FieldShell id={id} label={label} hint={hint} error={error} count={count}>
      <textarea
        id={id}
        rows={4}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(id, hint, error)}
        className={cn(
          CONTROL,
          "block resize-y py-2",
          controlBorder(Boolean(error)),
          className,
        )}
        {...props}
      />
    </FieldShell>
  );
}
