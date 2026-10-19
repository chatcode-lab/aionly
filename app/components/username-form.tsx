import { useState } from "react";
import { Form, useNavigation } from "react-router";

import {
  normalizeUsername,
  USERNAME_MAX,
  USERNAME_MIN,
  USERNAME_PROBLEM,
  usernameProblem,
} from "~/lib/accounts/usernames";
import { NAME_ALLOWANCES } from "~/lib/plan";

import { Button } from "./ui/button";
import { TextField } from "./ui/field";

/**
 * Edits the account's username. The rules are checked as the name is typed;
 * whether it is free is checked on submit. With `claimShort`, a name
 * shorter than the account may hold, which needs the yearly plan or the
 * 4-letter username, is offered as that: the button sends `intent=claim`,
 * for the page to lead on to the plan's page.
 */
export function UsernameForm({
  current,
  hint,
  error,
  submitLabel,
  disabled = false,
  staff = false,
  shortest = USERNAME_MIN,
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
  /** The shortest name the account may hold now. */
  shortest?: number;
  /** Offers a shorter name with what allows it, the yearly plan or the 4-letter username. */
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
  const found = name === current ? null : usernameProblem(name, { staff, shortest });
  // A short name to claim is no problem, only a different step.
  const claim = claimShort && (found === "short_plan" || found === "short_allowance") ? found : null;
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
        // What a short name needs, right under the field.
        note={
          claim === "short_plan"
            ? "Names of 5 characters come with the yearly Fan plan."
            : claim === "short_allowance"
              ? `Names of 4 characters need the 4-letter username add-on, bought once apart from the Fan plan: ${NAME_ALLOWANCES[4]!.label} plus VAT.`
              : undefined
        }
      />
      {beforeSubmit}
      <Button
        type="submit"
        variant="primary"
        name="intent"
        value={claim ? "claim" : "save"}
        disabled={disabled || busy || problem !== null}
      >
        {busy
          ? "Saving…"
          : claim === "short_plan"
            ? "Claim it with the yearly plan"
            : claim
              ? "Get the 4-letter username add-on"
              : submitLabel}
      </Button>
    </Form>
  );
}
