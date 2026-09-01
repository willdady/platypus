import { OrganizationForm } from "@/components/organization-form";
import { ResourcePage } from "@/components/resource-page";
import { ProtectedRoute } from "@/components/protected-route";

const OrganizationCreatePage = () => {
  return (
    <ProtectedRoute requireSuperAdmin={true}>
      <ResourcePage
        backFallbackHref="/"
        title="Create Organization"
        variant="wide"
      >
        <OrganizationForm />
      </ResourcePage>
    </ProtectedRoute>
  );
};

export default OrganizationCreatePage;
