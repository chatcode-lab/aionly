import { useState } from "react";
import { Form, useNavigation } from "react-router";

import {
  normalizeUsername,
  USERNAME_MAX,
  USERNAME_PROBLEM,
  usernameProblem,
} from "~/lib/accounts/usernames";

import { Button } from "./ui/button";
import { TextField } from "./ui/field";

/**
 * Edits the account's username. The rules are checked as the name is typed;
 * whether it is free is checked on submit.
 */
export function UsernameForm({
  current,
  hint,
  error,
  submitLabel,
  disabled = false,
  staff = false,
  short = false,
  onNameChange,
  children,
}: {
  current: string;
  hint: string;
  /** The server's answer to the last attempt. */
  error?: string;
  submitLabel: string;
  disabled?: boolean;
  /** Allows staff-like names, for admins. */
  staff?: boolean;
  /** Allows names of 4 or 5 characters: a member with the plan. */
  short?: boolean;
  /** Called with the name as typed, normalized, for a live preview. */
  onNameChange?: (name: string) => void;
  /** Hidden fields to send along, such as where to go next. */
  children?: React.ReactNode;
}) {
  const [value, setValue] = useState(current);
  const [edited, setEdited] = useState(false);
  const navigation = useNavigation();
  const name = normalizeUsername(value);
  const problem = name === current ? null : usernameProblem(name, { staff, short });
  const busy = navigation.state === "submitting";

  return (
    <Form method="post" className="space-y-3" onSubmit={() => setEdited(false)}>
      {children}
      <TextField
        label="Username"
        name="username"
        value={value}
        onChange={(event) => {
          setValue(event.target.value);
          setEdited(true);
          onNameChange?.(normalizeUsername(event.target.value));
        }}
        autoComplete="off"
        autoCapitalize="none"
        spellCheck={false}
        maxLength={USERNAME_MAX + 10}
        disabled={disabled}
        hint={hint}
        // The server's answer stands until the name is edited again.
        error={edited ? (problem ? USERNAME_PROBLEM[problem] : undefined) : error}
      />
      <Button type="submit" variant="primary" disabled={disabled || busy || problem !== null}>
        {busy ? "Saving…" : submitLabel}
      </Button>
    </Form>
  );
}
