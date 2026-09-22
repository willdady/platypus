/**
 * `REQUIRE_INVITATION_TO_SIGN_UP` (#550, ADR-0019): whether an account may
 * only come into existence by redeeming an Invitation link.
 *
 * Read in two places that must never disagree — `auth.ts`, where it drives
 * better-auth's own `disableSignUp` option and so closes the public sign-up
 * endpoint, and `GET /sign-up`, the one answer the frontend reads to decide
 * whether to offer Sign up. It governs sign-up only: Organization membership
 * and Workspace access are untouched by it.
 *
 * Default off, so an upgrading deployment's admission posture is unchanged
 * until the Operator opts in. Parsed like the codebase's other boolean
 * variables: trimmed, case-insensitive, and only `true` / `1` turn it on.
 */
export const requireInvitationToSignUp = (): boolean => {
  const raw = process.env.REQUIRE_INVITATION_TO_SIGN_UP?.trim().toLowerCase();
  return raw === "true" || raw === "1";
};
