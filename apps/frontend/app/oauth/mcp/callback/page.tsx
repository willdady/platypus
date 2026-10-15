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
    <OAuthCallbackHandler
      code={code}
      state={state}
      error={error}
      errorDescription={error_description}
    />
  );
};

export default OAuthCallbackPage;
