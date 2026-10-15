import { Bold, Code, Italic, Link2, List, ListOrdered, type LucideIcon, Quote, Strikethrough } from "lucide-react";
import { type RefObject, useEffect } from "react";
import { flushSync } from "react-dom";

import { applyFormat, type Format, shortcut } from "~/lib/text/format";

const BUTTONS: ReadonlyArray<{ format: Format; label: string; keys?: string; Icon: LucideIcon }> = [
  { format: "bold", label: "Bold", keys: "B", Icon: Bold },
  { format: "italic", label: "Italic", keys: "I", Icon: Italic },
  { format: "strike", label: "Strikethrough", keys: "Shift X", Icon: Strikethrough },
  { format: "link", label: "Insert link", keys: "K", Icon: Link2 },
  { format: "quote", label: "Quote", Icon: Quote },
  { format: "list", label: "Bulleted list", Icon: List },
  { format: "numbered", label: "Numbered list", Icon: ListOrdered },
  { format: "code", label: "Code", keys: "E", Icon: Code },
];

/**
 * Buttons above a text box that write the board's Markdown for the
 * selection: bold, italic, strikethrough, a link, a quote, lists, and code.
 * The same work is on Ctrl or Cmd with B, I, K, E, and Shift X. The text
 * stays Markdown, so what is typed is what is stored.
 */
export function FormatToolbar({
  textarea,
  onChange,
  disabled,
}: {
  textarea: RefObject<HTMLTextAreaElement | null>;
  onChange: (next: string) => void;
  disabled?: boolean;
}) {
  const apply = (format: Format) => {
    const element = textarea.current;
    if (!element || disabled) return;
    const edit = applyFormat(element.value, element.selectionStart, element.selectionEnd, format);
    // The new text goes in at once, so what is left to type can be selected now.
    flushSync(() => onChange(edit.text));
    element.focus();
    element.setSelectionRange(edit.start, edit.end);
  };

  useEffect(() => {
    const element = textarea.current;
    if (!element) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const format = shortcut(event);
      if (!format) return;
      event.preventDefault();
      apply(format);
    };
    element.addEventListener("keydown", onKeyDown);
    return () => element.removeEventListener("keydown", onKeyDown);
  });

  return (
    <div role="toolbar" aria-label="Formatting" className="flex flex-wrap">
      {BUTTONS.map(({ format, label, keys, Icon }) => (
        <button
          key={format}
          type="button"
          aria-label={label}
          // The same on the server and in every browser: Ctrl, or Cmd on a Mac.
          title={keys ? `${label} (Ctrl or ⌘ ${keys})` : label}
          disabled={disabled}
          // Keeps the selection in the text box while the button is pressed.
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => apply(format)}
          className="inline-flex size-8 items-center justify-center rounded-md text-text-muted hover:bg-surface-2 hover:text-text disabled:opacity-50 pointer-coarse:size-9"
        >
          <Icon size={16} aria-hidden />
        </button>
      ))}
    </div>
  );
}
