import { permanentRedirect } from "next/navigation";
import { orgRoutes } from "@/lib/routes";

type PageProps = {
  params: Promise<{
    orgId: string;
  }>;
};

async function Workspace({ params }: PageProps) {
  const { orgId } = await params;
  permanentRedirect(orgRoutes(orgId).root);
}

export default Workspace;
