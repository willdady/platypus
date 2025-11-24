"use client";

import { useEffect } from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { nanoid } from "nanoid";

const ChatPage = () => {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  useEffect(() => {
    // Extract orgId and workspaceId from pathname
    // Pathname format: /:orgId/workspace/:workspaceId/chat
    const pathParts = pathname.split("/").filter(Boolean);

    if (pathParts.length >= 4) {
      const orgId = pathParts[0]; // e.g., 'my-org'
      const workspaceId = pathParts[2]; // e.g., 'my-workspace'

      if (orgId && workspaceId) {
        // Generate a new chat ID and redirect to the specific chat page
        const newChatId = nanoid();
        const queryString = searchParams.toString();
        const redirectUrl = queryString
          ? `/${orgId}/workspace/${workspaceId}/chat/${newChatId}?${queryString}`
          : `/${orgId}/workspace/${workspaceId}/chat/${newChatId}`;
        router.replace(redirectUrl);
      }
    }
  }, [pathname, router, searchParams]);

  return null;
};

export default ChatPage;
