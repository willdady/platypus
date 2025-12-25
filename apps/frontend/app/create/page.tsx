import { OrganisationForm } from "@/components/organisation-form";
import { BackButton } from "@/components/back-button";
import { ProtectedRoute } from "@/components/protected-route";

const OrganisationCreatePage = () => {
  return (
    <ProtectedRoute requireSuperAdmin={true}>
      <div className="flex justify-center w-full p-4">
        <div className="w-lg">
          <BackButton fallbackHref="/" />
          <h1 className="text-2xl mb-4 font-bold">Create Organisation</h1>
          <OrganisationForm />
        </div>
      </div>
    </ProtectedRoute>
  );
};

export default OrganisationCreatePage;
