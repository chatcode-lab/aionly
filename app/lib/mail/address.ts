/**
 * Whether mail to this address can reach anyone: not a name reserved for
 * examples and tests (RFC 2606, RFC 6761), as staging's sample accounts
 * and tests use. Mail to those would only bounce, and bounces hurt the
 * domain's standing with every inbox.
 */
export function deliverable(email: string): boolean {
  const domain = email.slice(email.lastIndexOf("@") + 1).toLowerCase();
  if (!domain || !domain.includes(".")) return false;
  const reserved = ["invalid", "test", "example", "localhost", "local"];
  const labels = domain.split(".");
  if (reserved.includes(labels.at(-1)!)) return false;
  return !["example.com", "example.net", "example.org"].some((name) => domain === name || domain.endsWith(`.${name}`));
}
