import { permanentRedirect } from 'next/navigation';

interface PageProps {
  params: Promise<{
    orgId: string;
  }>;
}

const Workspace = async ({ params }: PageProps) => {
  const { orgId } = await params;
  permanentRedirect(`/${orgId}`);
};

export default Workspace;
