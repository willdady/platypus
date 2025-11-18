"use client";

import { useEffect, useState } from "react";
import { useRouter, usePathname } from "next/navigation";
import { nanoid } from "nanoid";

const ChatPage = () => {
  const router = useRouter();
  const pathname = usePathname();
  const [isReady, setIsReady] = useState(false);

  useEffect(() => {
    console.log("Current pathname:", pathname);

    // Extract orgId and workspaceId from pathname
    // Pathname format: /:orgId/workspace/:workspaceId/chat
    const pathParts = pathname.split("/").filter(Boolean);
    console.log("Path parts:", pathParts);

    if (pathParts.length >= 4) {
      const orgId = pathParts[0]; // e.g., 'my-org'
      const workspaceId = pathParts[2]; // e.g., 'my-workspace'

      console.log("Extracted:", { orgId, workspaceId });

      if (orgId && workspaceId) {
        // Generate a new chat ID and redirect to the specific chat page
        const newChatId = nanoid();
        console.log(
          "Redirecting to:",
          `/${orgId}/workspace/${workspaceId}/chat/${newChatId}`,
        );
        router.replace(`/${orgId}/workspace/${workspaceId}/chat/${newChatId}`);
        setIsReady(true);
      }
    }
  }, [pathname, router]);

  // Show loading while extracting params
  if (!isReady) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-gray-900 mx-auto mb-4"></div>
          <p className="text-gray-600">Starting new chat...</p>
          <p className="text-xs text-gray-400 mt-2">Path: {pathname}</p>
        </div>
      </div>
    );
  }

  return null;
};

export default ChatPage;
