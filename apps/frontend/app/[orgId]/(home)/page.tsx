"use client";

import { use } from "react";
import { OrgHome } from "@/components/org-home";

export default function OrgPage({
  params,
}: {
  params: Promise<{ orgId: string }>;
}) {
  const { orgId } = use(params);
  return <OrgHome orgId={orgId} />;
}
