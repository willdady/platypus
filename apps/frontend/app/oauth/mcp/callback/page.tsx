import { MAIN_CONTENT_ID } from "@/components/skip-link";
import { OAuthCallbackHandler } from "./oauth-callback-handler";

const OAuthCallbackPage = async ({
  searchParams,
}: {
  searchParams: Promise<{
    code?: string;
    state?: string;
    error?: string;
    error_description?: string;
  }>;
}) => {
  const { code, state, error, error_description } = await searchParams;

  return (
    <main id={MAIN_CONTENT_ID}>
      <OAuthCallbackHandler
        code={code}
        state={state}
        error={error}
        errorDescription={error_description}
      />
    </main>
  );
};

export default OAuthCallbackPage;
