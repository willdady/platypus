import type { Agent } from "@platypus/schemas";
import { Bot } from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "./ui/avatar";

export function AgentAvatar({
  agent,
  className,
}: {
  agent: Pick<Agent, "name" | "avatarUrl">;
  className?: string;
}) {
  return (
    <Avatar className={className}>
      {agent.avatarUrl && (
        <AvatarImage src={agent.avatarUrl} alt={agent.name} />
      )}
      <AvatarFallback>
        <Bot className="size-3/5 text-muted-foreground" />
      </AvatarFallback>
    </Avatar>
  );
}
