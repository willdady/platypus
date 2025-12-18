import { OrganisationForm } from "@/components/organisation-form";
import { BackButton } from "@/components/back-button";

const OrganisationCreatePage = () => {
  return (
    <div className="flex justify-center w-full p-4">
      <div className="w-lg">
        <BackButton fallbackHref="/" />
        <h1 className="text-2xl mb-4 font-bold">Create Organisation</h1>
        <OrganisationForm />
      </div>
    </div>
  );
};

export default OrganisationCreatePage;
