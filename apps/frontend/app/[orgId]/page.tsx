const Org = async ({ params }: { params: Promise<{ orgId: string }> }) => {
  const { orgId } = await params;

  return (
    <div>
      <h1>Hello org: {orgId}</h1>
    </div>
  );
};

export default Org;
