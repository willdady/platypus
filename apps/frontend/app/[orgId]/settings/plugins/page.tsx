import { PluginsList } from "@/components/plugins-list";

const OrgPluginsPage = async ({
  params,
}: {
  params: Promise<{ orgId: string }>;
}) => {
  const { orgId } = await params;

  return (
    <div>
      <h1 className="text-2xl font-bold mb-4">Installed Plugins</h1>
      <p className="text-muted-foreground mb-6">
        Plugins extend this deployment with Tool sets and Sandbox backends. They
        are installed and enabled at deploy time by the operator (via the{" "}
        <code>PLATYPUS_PLUGINS</code> environment variable), not from the app —
        this view is read-only.
      </p>
      <PluginsList orgId={orgId} />
    </div>
  );
};

export default OrgPluginsPage;
