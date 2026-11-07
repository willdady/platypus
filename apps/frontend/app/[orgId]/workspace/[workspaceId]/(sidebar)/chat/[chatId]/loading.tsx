import { ChatSkeleton } from "@/components/chat-skeleton";

// The page awaits the Workspace row on the server before it renders anything,
// so without this a navigation from one Chat to another sat on the previous
// Chat with no feedback.
export default function ChatLoading() {
  return <ChatSkeleton transcript readOnly={false} />;
}
