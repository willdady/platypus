export const TIMEZONES = ["UTC", ...Intl.supportedValuesOf("timeZone")];

export function getBrowserTimezone(): string {
  try {
    const browserTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return TIMEZONES.includes(browserTz) ? browserTz : "UTC";
  } catch {
    return "UTC";
  }
}
