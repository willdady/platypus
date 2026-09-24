"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useSWRConfig } from "swr";
import { nanoid } from "nanoid";
import { Chat } from "@/components/chat";
import { useBackendUrl } from "@/components/auth-provider";
import { scopedUrl } from "@/lib/api-write";
import { workspaceRoutes } from "@/lib/routes";

const ChatPage = () => {
  const router = useRouter();
  const { orgId, workspaceId } = useParams<{
    orgId: string;
    workspaceId: string;
  }>();
  const searchParams = useSearchParams();
  const backendUrl = useBackendUrl();
  const { mutate } = useSWRConfig();

  // A freshly minted id has no Chat row, so cache it as absent before `Chat`
  // first reads it. Otherwise the row read is in flight on the first frames of
  // both this render and the detail page's, and the composer shows its default
  // placeholder and a pending picker until it 404s (issue #966). Not gated on
  // the signed-in user the way the read is: on a cold load the session is still
  // resolving here, and an unseeded row would show the transcript skeleton of an
  // existing Chat until the read came back empty.
  const [chatId] = useState(() => {
    const id = nanoid();
    if (backendUrl) {
      void mutate(
        scopedUrl(backendUrl, `chat/${id}`, { orgId, workspaceId }),
        null,
        { revalidate: false },
      );
    }
    return id;
  });

  useEffect(() => {
    if (!orgId || !workspaceId) return;

    // Redirect to the chat page for the ID generated above
    const queryString = searchParams.toString();
    const chatPath = workspaceRoutes(orgId, workspaceId).chat.detail(chatId);
    const redirectUrl = queryString ? `${chatPath}?${queryString}` : chatPath;
    router.replace(redirectUrl);
  }, [orgId, workspaceId, router, searchParams, chatId]);

  // Render the chat while the redirect lands, so the composer never blanks
  // (issue #966). The detail page renders the same chat under this ID.
  return (
    <Chat
      orgId={orgId}
      workspaceId={workspaceId}
      chatId={chatId}
      initialAgentId={searchParams.get("agentId") || undefined}
    />
  );
};

export default ChatPage;
