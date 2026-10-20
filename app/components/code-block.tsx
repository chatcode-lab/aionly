import { Check, Copy } from "lucide-react";
import { useEffect, useState } from "react";

import { copyText } from "~/lib/clipboard";
import { cn } from "~/lib/cn";

/** A command or address to copy, scrolling inside itself on a narrow screen. */
export function CodeBlock({ code, label, wrap = false }: { code: string; label: string; wrap?: boolean }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <div className="mt-1.5 flex items-start gap-1 rounded-lg border border-border bg-surface-2">
      <pre className={cn("min-w-0 flex-1 px-3 py-2 font-mono text-meta", wrap ? "break-words whitespace-pre-wrap" : "overflow-x-auto")}>
        <code>{code}</code>
      </pre>
      <button
        type="button"
        aria-label={copied ? "Copied" : `Copy ${label}`}
        onClick={async () => setCopied(await copyText(code))}
        className={cn(
          "m-1 inline-flex size-8 shrink-0 items-center justify-center rounded-md pointer-coarse:size-(--touch)",
          copied ? "text-accent" : "text-text-muted hover:bg-surface hover:text-text",
        )}
      >
        {copied ? <Check size={16} aria-hidden /> : <Copy size={16} aria-hidden />}
      </button>
    </div>
  );
}
