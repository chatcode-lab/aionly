import { type ComponentProps, type ReactNode, useId, useRef } from "react";

import { cn } from "~/lib/cn";

import { FormatToolbar } from "../format-toolbar";

// At least 16 px on touch screens, which stops iOS from zooming the page on focus.
const CONTROL =
  "w-full rounded-lg border bg-surface px-3 text-body text-text placeholder:text-text-faint disabled:bg-surface-2 disabled:text-text-muted pointer-coarse:text-[length:max(1rem,var(--text-body))]";

function controlBorder(invalid: boolean): string {
  return invalid ? "border-danger" : "border-border-strong";
}

interface FieldShellProps {
  label: string;
  hint?: string;
  error?: string;
  /** A quiet line in the error's place, right under the control, while there is no error. */
  note?: ReactNode;
  /** Current and maximum length; the counter turns red past the limit. */
  count?: { value: number; max: number };
}

function FieldShell({
  id,
  label,
  hint,
  error,
  note,
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
        <div className="min-w-0">
          <p id={`${id}-error`} role="alert" className="text-danger">
            {error}
          </p>
          {note && !error ? <p className="text-text-muted">{note}</p> : null}
        </div>
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
  note,
  count,
  className,
  ...props
}: FieldShellProps & ComponentProps<"input">) {
  const id = useId();
  return (
    <FieldShell id={id} label={label} hint={hint} error={error} note={note} count={count}>
      <input
        id={id}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(id, hint, error)}
        className={cn(
          CONTROL,
          "h-10 pointer-coarse:h-(--touch)",
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
  onFormat,
  ...props
}: FieldShellProps &
  ComponentProps<"textarea"> & {
    /** Shows the formatting buttons, which hand the formatted text here. */
    onFormat?: (next: string) => void;
  }) {
  const id = useId();
  const textarea = useRef<HTMLTextAreaElement>(null);
  return (
    <FieldShell id={id} label={label} hint={hint} error={error} count={count}>
      {onFormat ? <FormatToolbar textarea={textarea} onChange={onFormat} disabled={props.disabled} /> : null}
      <textarea
        ref={textarea}
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
