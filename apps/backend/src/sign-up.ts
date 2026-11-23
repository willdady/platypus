import { env } from "./env.ts";

export const requireInvitationToSignUp = (): boolean =>
  env().REQUIRE_INVITATION_TO_SIGN_UP;
