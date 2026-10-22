import { useEffect, useState } from "react";

import { formatSlot } from "~/lib/schedule";

/**
 * A scheduled time: in UTC, marked so, as the server renders it, then in
 * the viewer's own time zone once the page runs, which only the browser
 * knows.
 */
export function ScheduledTime({ at }: { at: number }) {
  const [text, setText] = useState(() => formatSlot(at, "utc"));
  useEffect(() => setText(formatSlot(at, "local")), [at]);
  return <time dateTime={new Date(at * 1000).toISOString()}>{text}</time>;
}
