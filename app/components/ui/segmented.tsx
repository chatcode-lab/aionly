import { cn } from "~/lib/cn";

/**
 * A two- or three-way switch for a choice held in the page, such as link or
 * upload on the submit form. Choices that live in the URL use `LinkTabs`.
 */
export function Segmented<Value extends string>({
  label,
  options,
  value,
  onChange,
}: {
  /** Names the choice for assistive technology. */
  label: string;
  options: Array<{ value: Value; label: string }>;
  value: Value;
  onChange: (next: Value) => void;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className="inline-flex gap-0.5 rounded-lg bg-surface-2 p-0.5"
    >
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(option.value)}
            className={cn(
              "inline-flex h-8 items-center rounded-md px-3 text-body whitespace-nowrap transition-colors duration-150 pointer-coarse:h-10",
              active
                ? "bg-surface font-medium text-text shadow-sm"
                : "text-text-muted hover:text-text",
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
