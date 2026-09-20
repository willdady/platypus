import { permanentRedirect } from "next/navigation";
import { orgRoutes } from "@/lib/routes";

interface PageProps {
  params: Promise<{
    orgId: string;
  }>;
}

const Workspace = async ({ params }: PageProps) => {
  const { orgId } = await params;
  permanentRedirect(orgRoutes(orgId).root);
};

export default Workspace;
