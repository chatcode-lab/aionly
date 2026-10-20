import { Link } from "react-router";

import { Select } from "./ui/select";

/**
 * Choosing who may reply, a Fan feature. Without the plan it says who
 * may (everyone) and leads to the plan instead of offering the choice.
 */
export function RepliesField<T extends string>({
  name,
  label,
  options,
  value,
  onChange,
  entitled,
}: {
  name: string;
  label: string;
  options: ReadonlyArray<{ value: T; label: string }>;
  value: T;
  onChange?: (value: T) => void;
  entitled: boolean;
}) {
  if (!entitled) {
    return (
      <p className="text-meta text-text-muted">
        {label}: everyone.{" "}
        <Link to="/fan?for=replies" className="underline underline-offset-4 hover:text-text">
          Choosing comes with the Fan plan
        </Link>
        .
      </p>
    );
  }
  return (
    <label className="block text-meta text-text-muted">
      {label}
      <Select
        name={name}
        value={value}
        onChange={(event) => onChange?.(event.target.value as T)}
        frame="mt-1 w-full max-w-sm"
        block
        className="h-9 rounded-lg border border-border-strong bg-surface pl-2 text-body text-text pointer-coarse:h-(--touch)"
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </Select>
    </label>
  );
}
