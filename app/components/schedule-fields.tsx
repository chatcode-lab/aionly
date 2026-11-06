import { type ReactNode, useEffect, useState } from "react";

import { Select } from "~/components/ui/select";
import { firstSlot, fromLocalParts, localParts, QUARTER_HOURS, SCHEDULE_DAYS } from "~/lib/schedule";

export interface ScheduleTime {
  day: string;
  time: string;
  setDay: (day: string) => void;
  setTime: (time: string) => void;
  days: { min: string; max: string };
  /** The moment the fields name, or null until the page runs. */
  at: number | null;
}

/**
 * A date and a quarter hour in the viewer's own time zone, to schedule a
 * draft: filled once the page runs, since only the browser knows its zone,
 * at `start` while that is still to come, else at the first quarter hour a
 * form offers.
 */
export function useScheduleTime(start: number | null): ScheduleTime {
  const [day, setDay] = useState("");
  const [time, setTime] = useState("");
  const [days, setDays] = useState({ min: "", max: "" });
  useEffect(() => {
    const now = Math.floor(Date.now() / 1000);
    const parts = localParts(start !== null && start > now ? start : firstSlot(now));
    setDay(parts.date);
    setTime(parts.time);
    setDays({ min: localParts(now).date, max: localParts(now + SCHEDULE_DAYS * 24 * 3600).date });
  }, [start]);
  return { day, time, setDay, setTime, days, at: fromLocalParts(day, time) };
}

/** The fields for a ScheduleTime, with what they mean beneath, and why a time was refused. */
export function ScheduleFields({ value, hint, error }: { value: ScheduleTime; hint: ReactNode; error?: string }) {
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap gap-2">
        <input
          type="date"
          aria-label="Date"
          value={value.day}
          min={value.days.min}
          max={value.days.max}
          onChange={(event) => value.setDay(event.target.value)}
          className="h-9 rounded-lg border border-border-strong bg-surface px-2 text-body text-text"
        />
        <Select
          aria-label="Time"
          value={value.time}
          onChange={(event) => value.setTime(event.target.value)}
          className="h-9 rounded-lg border border-border-strong bg-surface pl-2 text-body text-text"
        >
          {QUARTER_HOURS.map((slot) => (
            <option key={slot} value={slot}>
              {slot}
            </option>
          ))}
        </Select>
      </div>
      <p className="text-meta text-text-muted">{hint}</p>
      {error ? (
        <p role="alert" className="text-meta text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}
