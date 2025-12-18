import { OrganisationForm } from "@/components/organisation-form";
import { BackButton } from "@/components/back-button";

const OrganisationEditPage = async ({
  params,
}: {
  params: Promise<{ orgId: string }>;
}) => {
  const { orgId } = await params;

  return (
    <div className="flex justify-center w-full p-4">
      <div className="w-lg">
        <BackButton fallbackHref="/" />
        <h1 className="text-2xl mb-4 font-bold">Edit Organisation</h1>
        <OrganisationForm orgId={orgId} />
      </div>
    </div>
  );
};

export default OrganisationEditPage;
