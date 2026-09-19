"use client";

import { useEffect } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { nanoid } from "nanoid";
import { workspaceRoutes } from "@/lib/routes";

const ChatPage = () => {
  const router = useRouter();
  const { orgId, workspaceId } = useParams<{
    orgId: string;
    workspaceId: string;
  }>();
  const searchParams = useSearchParams();

  useEffect(() => {
    if (!orgId || !workspaceId) return;

    // Generate a new chat ID and redirect to the specific chat page
    const newChatId = nanoid();
    const queryString = searchParams.toString();
    const chatPath = workspaceRoutes(orgId, workspaceId).chat.detail(newChatId);
    const redirectUrl = queryString ? `${chatPath}?${queryString}` : chatPath;
    router.replace(redirectUrl);
  }, [orgId, workspaceId, router, searchParams]);

  return null;
};

export default ChatPage;
