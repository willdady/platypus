import type { Metadata } from "next";
import { PluginsList } from "@/components/plugins-list";
import { PageHeader } from "@/components/page-header";

export const metadata: Metadata = { title: "Installed Plugins" };

async function OrgPluginsPage({
  params,
}: {
  params: Promise<{ orgId: string }>;
}) {
  const { orgId } = await params;

  return (
    <div>
      <PageHeader
        title="Installed Plugins"
        description={
          <>
            Plugins extend this deployment with Tool sets and Sandbox backends.
            They are installed and enabled at deploy time by the operator (via
            the <code>PLATYPUS_PLUGINS</code> environment variable), not from
            the app — this view is read-only.
          </>
        }
      />
      <PluginsList orgId={orgId} />
    </div>
  );
}

export default OrgPluginsPage;
