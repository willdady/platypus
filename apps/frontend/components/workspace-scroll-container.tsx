"use client";

import { usePathname } from "next/navigation";
import { useSWRConfig } from "swr";
import { PullToRefresh } from "@/components/pull-to-refresh";

const CONTENT_CLASSES =
  "flex-1 min-h-0 min-w-0 overflow-y-auto overflow-x-hidden";

export function WorkspaceScrollContainer({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const { mutate } = useSWRConfig();

  // Chat manages its own scrolling via StickToBottom and doesn't benefit from
  // pull-to-refresh. Wrapping it causes overscroll-behavior-y:contain to
  // prevent the browser from scrolling the input into view when the mobile
  // keyboard opens.
  const isChatRoute = /\/chat(\/|$)/.test(pathname);

  if (isChatRoute) {
    return <div className={CONTENT_CLASSES}>{children}</div>;
  }

  async function handleRefresh() {
    await mutate(() => true, undefined, { revalidate: true });
  }

  return (
    <PullToRefresh onRefresh={handleRefresh} className={CONTENT_CLASSES}>
      {children}
    </PullToRefresh>
  );
}
