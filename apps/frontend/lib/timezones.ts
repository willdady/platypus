/** Every IANA zone the browser knows, with `UTC` first. */
export const TIMEZONES = ["UTC", ...Intl.supportedValuesOf("timeZone")];

/** The browser's zone if it is in {@link TIMEZONES}, else `UTC`. */
export const getBrowserTimezone = (): string => {
  try {
    const browserTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return TIMEZONES.includes(browserTz) ? browserTz : "UTC";
  } catch {
    return "UTC";
  }
};
