import { reportClientError } from "@/lib/error-reporting";

/**
 * Runs in the browser before the app starts. Errors nothing else caught — a
 * throw in a timer or event handler, a rejected promise nobody awaited — go
 * to the same reporter the error boundaries use.
 *
 * Reporting is off until a reporter is set. To send errors to your own
 * service, set one here:
 *
 *   import { setErrorReporter } from "@/lib/error-reporting";
 *   setErrorReporter((error, { source, digest }) => { ... });
 */
window.addEventListener("error", (event) => {
  reportClientError(event.error ?? event.message, { source: "window-error" });
});

window.addEventListener("unhandledrejection", (event) => {
  reportClientError(event.reason, { source: "unhandledrejection" });
});
