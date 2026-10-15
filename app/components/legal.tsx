import type { ReactNode } from "react";

/**
 * The rules, terms, and privacy pages: plain reading in the board's column,
 * headings and lists styled here so the pages themselves stay prose.
 */
export function LegalPage({ title, updated, children }: { title: string; updated: string; children: ReactNode }) {
  return (
    <main className="mx-auto max-w-column px-(--gutter) py-6">
      <h1 className="text-display font-semibold">{title}</h1>
      <p className="mt-1 text-meta text-text-muted">Last updated {updated}</p>
      <div className="text-body [&_a]:underline [&_a]:underline-offset-4 [&_h2]:mt-7 [&_h2]:scroll-mt-16 [&_h2]:text-title [&_h2]:font-semibold [&_li]:mt-1 [&_p]:mt-2 [&_ul]:mt-2 [&_ul]:list-disc [&_ul]:pl-5">
        {children}
      </div>
    </main>
  );
}

export function Mail({ to }: { to: string }) {
  return <a href={`mailto:${to}`}>{to}</a>;
}
