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
 * whether it is free is checked on submit. With `claimShort`, a name of 4
 * or 5 characters, which needs the yearly plan, is offered as that: the
 * button sends `intent=claim`, for the page to lead on to the plan.
 */
export function UsernameForm({
  current,
  hint,
  error,
  submitLabel,
  disabled = false,
  staff = false,
  short = false,
  claimShort = false,
  onNameChange,
  children,
  beforeSubmit,
}: {
  current: string;
  hint: string;
  /** The server's answer to the last attempt. */
  error?: string;
  submitLabel: string;
  disabled?: boolean;
  /** Allows staff-like names, for admins. */
  staff?: boolean;
  /** Allows names of 4 or 5 characters: an admin, or a member with the yearly plan. */
  short?: boolean;
  /** Offers a name of 4 or 5 characters with the yearly plan, where it is not allowed yet. */
  claimShort?: boolean;
  /** Called with the name as typed, normalized, for a live preview. */
  onNameChange?: (name: string) => void;
  /** Hidden fields to send along, such as where to go next. */
  children?: React.ReactNode;
  /** Shown just above the button, such as a choice sent along with the name. */
  beforeSubmit?: React.ReactNode;
}) {
  const [value, setValue] = useState(current);
  const [edited, setEdited] = useState(false);
  const navigation = useNavigation();
  const name = normalizeUsername(value);
  const found = name === current ? null : usernameProblem(name, { staff, short });
  // A short name to claim with the plan is no problem, only a different step.
  const claim = claimShort && found === "short_plan";
  const problem = claim ? null : found;
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
      {claim ? (
        <p className="text-meta text-text-muted">
          Names of 4 or 5 characters come with the yearly Fan plan. Claim it, and it is yours as soon as you pay.
        </p>
      ) : null}
      {beforeSubmit}
      <Button
        type="submit"
        variant="primary"
        name="intent"
        value={claim ? "claim" : "save"}
        disabled={disabled || busy || problem !== null}
      >
        {busy ? "Saving…" : claim ? "Claim it with the yearly plan" : submitLabel}
      </Button>
    </Form>
  );
}
