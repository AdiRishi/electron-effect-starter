import * as Schema from "effect/Schema";
import { useEffect, useRef, useState } from "react";

export class ClipboardApiUnavailableError extends Schema.TaggedError<ClipboardApiUnavailableError>()(
  "ClipboardApiUnavailableError",
  {
    target: Schema.String,
  },
) {
  override get message(): string {
    return `Clipboard API is unavailable while copying ${this.target}.`;
  }
}

export class ClipboardWriteError extends Schema.TaggedError<ClipboardWriteError>()(
  "ClipboardWriteError",
  {
    target: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to copy ${this.target} to the clipboard.`;
  }
}

// Plain http has no Clipboard API, but the legacy copy command still works on a selection.
function writeTextWithExecCommand(value: string): boolean {
  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "");
  textarea.setAttribute("aria-hidden", "true");
  textarea.style.position = "fixed";
  textarea.style.top = "0";
  textarea.style.left = "0";
  textarea.style.opacity = "0";
  textarea.style.fontSize = "16px";

  const previouslyFocused = document.activeElement;
  document.body.appendChild(textarea);

  try {
    textarea.focus({ preventScroll: true });
    textarea.select();
    textarea.setSelectionRange(0, value.length);

    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    textarea.remove();

    if (previouslyFocused instanceof HTMLElement) previouslyFocused.focus();
  }
}

export async function writeTextToClipboard(value: string, target = "text") {
  if (!value) return false;

  if (!window.isSecureContext || navigator.clipboard === undefined) {
    if (writeTextWithExecCommand(value)) return true;

    throw new ClipboardApiUnavailableError({ target });
  }

  try {
    await navigator.clipboard.writeText(value);

    return true;
  } catch (cause) {
    throw new ClipboardWriteError({ target, cause });
  }
}

export function useCopyToClipboard({
  timeout = 2000,
  target = "text",
}: {
  timeout?: number;
  target?: string;
} = {}) {
  const [isCopied, setIsCopied] = useState(false);
  const timeoutIdRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const copyToClipboard = (value: string): void => {
    void writeTextToClipboard(value, target).then(
      (didCopy) => {
        if (!didCopy) return;

        if (timeoutIdRef.current) {
          clearTimeout(timeoutIdRef.current);
        }

        setIsCopied(true);

        if (timeout !== 0) {
          timeoutIdRef.current = setTimeout(() => {
            setIsCopied(false);
            timeoutIdRef.current = null;
          }, timeout);
        }
      },
      (error) => {
        console.error(error);
      },
    );
  };

  useEffect(() => {
    return (): void => {
      if (timeoutIdRef.current) {
        clearTimeout(timeoutIdRef.current);
      }
    };
  }, []);

  return { copyToClipboard, isCopied };
}
