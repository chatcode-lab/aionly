/**
 * Removes every match of `pattern` (global), again and again until none is
 * left, so that taking one out cannot join the text around it into another,
 * as removing `<scr<script>ipt>` once would.
 */
export function removeAll(text: string, pattern: RegExp): string {
  let previous: string;
  let next = text;
  do {
    previous = next;
    next = previous.replace(pattern, "");
  } while (next !== previous);
  return next;
}
