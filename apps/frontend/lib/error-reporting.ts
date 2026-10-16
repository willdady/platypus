/**
 * Where an error was caught: an error boundary (`segment`, `root`,
 * `message-part`) or a window-level listener for one nothing caught.
 */
export type ErrorSource =
  "root" | "segment" | "message-part" | "window-error" | "unhandledrejection";

export type ErrorReport = {
  source: ErrorSource;
  /** The hash Next.js gives a server error, matching the server's log line. */
  digest?: string;
};

export type ErrorReporter = (error: unknown, report: ErrorReport) => void;

let reporter: ErrorReporter | null = null;

/**
 * Sends client errors to a reporter of your choosing (Sentry, a logging
 * endpoint). Nothing is sent until one is set; `null` turns reporting off
 * again. Set it from `instrumentation-client.ts`, which runs before the app.
 */
export const setErrorReporter = (next: ErrorReporter | null): void => {
  reporter = next;
};

/**
 * Hands an error to the reporter, if one is set. Called by every error
 * boundary and by the window listeners. A reporter that throws is ignored:
 * reporting must never turn one failure into two.
 */
export const reportClientError = (
  error: unknown,
  report: ErrorReport,
): void => {
  if (!reporter) return;
  try {
    reporter(error, report);
  } catch {
    // Deliberately swallowed; see above.
  }
};
