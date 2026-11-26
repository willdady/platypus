import type { Agent } from "@platypus/schemas";
import { Bot } from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "./ui/avatar";

export function AgentAvatar({
  agent,
  className,
  alt,
  decorative = false,
}: {
  agent: Pick<Agent, "name" | "avatarUrl">;
  className?: string;
  alt?: string;
  decorative?: boolean;
}) {
  return (
    <Avatar className={className}>
      {agent.avatarUrl && (
        <AvatarImage
          className="object-cover"
          src={agent.avatarUrl}
          alt={decorative ? "" : (alt ?? agent.name)}
        />
      )}
      <AvatarFallback
        role={decorative ? undefined : "img"}
        aria-label={
          decorative ? undefined : `${agent.name || "Assistant"} avatar`
        }
        aria-hidden={decorative || undefined}
      >
        <Bot className="size-3/5 text-muted-foreground" />
      </AvatarFallback>
    </Avatar>
  );
}
