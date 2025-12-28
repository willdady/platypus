import { OrganizationForm } from "@/components/organization-form";
import { BackButton } from "@/components/back-button";
import { ProtectedRoute } from "@/components/protected-route";

const OrganizationCreatePage = () => {
  return (
    <ProtectedRoute requireSuperAdmin={true}>
      <div className="flex justify-center w-full p-4">
        <div className="w-lg">
          <BackButton fallbackHref="/" />
          <h1 className="text-2xl mb-4 font-bold">Create Organization</h1>
          <OrganizationForm />
        </div>
      </div>
    </ProtectedRoute>
  );
};

export default OrganizationCreatePage;
