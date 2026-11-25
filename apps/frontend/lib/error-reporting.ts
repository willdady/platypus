export type ErrorSource =
  "root" | "segment" | "message-part" | "window-error" | "unhandledrejection";

export type ErrorReport = {
  source: ErrorSource;
  digest?: string;
};

export type ErrorReporter = (error: unknown, report: ErrorReport) => void;

let reporter: ErrorReporter | null = null;

export function setErrorReporter(next: ErrorReporter | null): void {
  reporter = next;
}

export function reportClientError(error: unknown, report: ErrorReport): void {
  if (!reporter) return;
  try {
    reporter(error, report);
  } catch {
    // why: reporting must never turn one failure into two
  }
}
