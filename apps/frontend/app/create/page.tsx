import { MAIN_CONTENT_ID } from "@/components/skip-link";
import { appRoutes } from "@/lib/routes";
import { OrganizationForm } from "@/components/organization-form";
import { ResourcePage } from "@/components/resource-page";
import { ProtectedRoute } from "@/components/protected-route";

const OrganizationCreatePage = () => {
  return (
    <ProtectedRoute requireSuperAdmin={true}>
      <main id={MAIN_CONTENT_ID}>
        <ResourcePage
          backFallbackHref={appRoutes.home}
          title="Create Organization"
          variant="wide"
        >
          <OrganizationForm />
        </ResourcePage>
      </main>
    </ProtectedRoute>
  );
};

export default OrganizationCreatePage;
