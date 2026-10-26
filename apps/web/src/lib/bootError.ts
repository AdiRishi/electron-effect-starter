import type { DesktopBridge } from "@app/contracts";

const LAST_FAILURE_KEY = "electron-effect-starter:boot-failed-at";
const REPEAT_FAILURE_MS = 5 * 60_000;
const MAX_CAUSES = 3;
const MAX_ERROR_CHARS = 6_000;
const COPY_BLOCKED = "Copy was blocked. The text is selected so you can copy it manually.";

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- formats any thrown value.
function safeString(value: unknown) {
  try {
    return String(value);
  } catch {
    return "";
  }
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- formats any thrown value.
function describeOne(value: unknown) {
  if (value instanceof Error) {
    const header = value.message ? `${value.name}: ${value.message}` : value.name;
    // V8 stacks start with the header; Safari and Firefox stacks do not.
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- a thrown value's stack can be anything.
    const stack = typeof value.stack === "string" ? value.stack : "";

    return stack === header || stack.startsWith(`${header}\n`)
      ? stack
      : [header, stack].filter(Boolean).join("\n");
  }

  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- anything can be thrown.
  if (typeof value === "string") return value;

  try {
    return JSON.stringify(value) ?? safeString(value);
  } catch {
    return safeString(value);
  }
}

/** Hosts can name private machines, and pairing tokens live in query strings and hashes. */
function redact(text: string) {
  return text
    .replace(/\b[a-z][\w+.-]*:\/\/[^\s/?#'"()]+/gi, "")
    .replace(/[?#][^\s'"()]*=[^\s'"()]*?((?::\d+){1,2})?(?=[\s'"()]|$)/g, "$1");
}

export interface BootErrorEnvironment {
  readonly version: string;
  readonly surface: "desktop" | "web";
  readonly platform: string;
  readonly userAgent: string;
  readonly time: string;
}

/** Plain text that is shown and copied as-is, so users see exactly what they share. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- reports any thrown value.
export function buildErrorReport(error: unknown, environment: BootErrorEnvironment) {
  const parts: Array<string> = [];
  const seen = new Set<unknown>();
  let current = error;

  while (current != null && !seen.has(current) && parts.length <= MAX_CAUSES) {
    seen.add(current);
    const text = describeOne(current);
    parts.push(parts.length === 0 ? text : `Caused by: ${text}`);
    current = current instanceof Error ? current.cause : undefined;
  }

  let details = redact(parts.join("\n") || "(no error message)");

  if (details.length > MAX_ERROR_CHARS) {
    details = `${details.slice(0, MAX_ERROR_CHARS)}\n[truncated]`;
  }

  return [
    details,
    "",
    `Version: ${environment.version}`,
    `Surface: ${environment.surface}`,
    `Platform: ${environment.platform}`,
    `User agent: ${environment.userAgent}`,
    `Time: ${environment.time}`,
  ].join("\n");
}

function clientPlatform(bridge: DesktopBridge | undefined) {
  try {
    return bridge?.getClientPlatform() ?? navigator.platform;
  } catch {
    return navigator.platform;
  }
}

function readEnvironment(bridge: DesktopBridge | undefined): BootErrorEnvironment {
  return {
    version: import.meta.env.APP_VERSION,
    surface: bridge ? "desktop" : "web",
    platform: clientPlatform(bridge),
    userAgent: navigator.userAgent,
    time: new Date().toISOString(),
  };
}

/** Opens the details by default when startup already failed in this tab a moment ago. */
function isRepeatFailure(now: number) {
  try {
    const previous = Number(sessionStorage.getItem(LAST_FAILURE_KEY));
    sessionStorage.setItem(LAST_FAILURE_KEY, String(now));

    return now - previous < REPEAT_FAILURE_MS;
  } catch {
    return false;
  }
}

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> = {},
  children: ReadonlyArray<Node | string> = [],
) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);

  return node;
}

function selectContents(target: HTMLElement) {
  const range = document.createRange();
  range.selectNodeContents(target);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

function copySelection() {
  try {
    return document.execCommand("copy");
  } catch {
    return false;
  }
}

/** Plain http has no Clipboard API, but the legacy copy command still works on a selection. */
function copyText(target: HTMLElement, onCopied: () => void, onBlocked: (hint: string) => void) {
  const fallback = () => {
    selectContents(target);

    if (copySelection()) return onCopied();
    onBlocked(
      /Mac|iPhone|iPad/.test(navigator.platform) ? "Press ⌘C to copy" : "Press Ctrl+C to copy",
    );
  };

  const clipboard = window.isSecureContext ? navigator.clipboard : undefined;

  if (clipboard === undefined) return fallback();
  clipboard.writeText(target.textContent ?? "").then(onCopied, fallback);
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- shows whatever startup threw.
export function showBootError(error: unknown) {
  console.error("The app failed to start.", error);
  const root = document.getElementById("root");

  if (!root) return;

  const bridge = window.desktopBridge;
  const environment = readEnvironment(bridge);
  const offline = !bridge && navigator.onLine === false;

  const status = element("span", { className: "boot-error-sr" });
  status.setAttribute("aria-live", "polite");
  // Clearing first makes screen readers announce a repeated message.
  let announcement: ReturnType<typeof setTimeout> | undefined;

  const announce = (text: string) => {
    clearTimeout(announcement);
    status.textContent = "";
    announcement = setTimeout(() => (status.textContent = text), 100);
  };

  const message = element("div", {}, [
    element("h1", { textContent: "The app failed to start" }),
    element("p", {
      textContent: offline
        ? "This browser appears to be offline. Check the connection, then reload."
        : "We are not sure why. Try a reload first.",
    }),
  ]);

  message.setAttribute("role", "alert");

  const reload = element("button", {
    id: "boot-error-reload",
    type: "button",
    textContent: "Reload",
  });

  reload.addEventListener("click", () => window.location.reload());

  let report = "(no error message)";

  try {
    report = buildErrorReport(error, environment);
  } catch (reportError) {
    console.warn("Could not describe the startup error.", reportError);
  }

  const details = element("pre", { id: "boot-error-details", tabIndex: 0, textContent: report });
  const copyDetails = element("button", { type: "button", textContent: "Copy error details" });

  copyDetails.addEventListener("click", () =>
    copyText(
      details,
      () => {
        copyDetails.textContent = "Copied";
        announce("Copied to clipboard.");
      },
      (hint) => {
        copyDetails.textContent = hint;
        announce(COPY_BLOCKED);
      },
    ),
  );

  const more = element("details", { open: isRepeatFailure(Date.now()) }, [
    element("summary", { textContent: "Error details" }),
    element("div", {}, [
      details,
      element("p", {
        textContent: "Details may include local file paths and names. Check before sharing.",
      }),
      element("div", { id: "boot-error-report" }, [copyDetails]),
    ]),
  ]);

  root.replaceChildren(
    element("div", { id: "boot-shell" }, [
      element("div", { id: "boot-error" }, [
        message,
        element("div", { id: "boot-error-actions" }, [reload]),
        more,
        status,
      ]),
    ]),
  );
}
