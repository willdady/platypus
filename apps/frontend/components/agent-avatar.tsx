import type { Agent } from "@platypus/schemas";
import { Bot } from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "./ui/avatar";

export function AgentAvatar({
  agent,
  className,
  alt,
  delayMs,
}: {
  agent: Pick<Agent, "name" | "avatarUrl">;
  className?: string;
  /** Overrides the image's accessible name; defaults to the agent's name. */
  alt?: string;
  /**
   * Waits this long before showing the Bot icon while the image loads, so a
   * slow image does not flash the icon first. Off by default.
   */
  delayMs?: number;
}) {
  return (
    <Avatar className={className}>
      {agent.avatarUrl && (
        <AvatarImage
          className="object-cover"
          src={agent.avatarUrl}
          alt={alt ?? agent.name}
        />
      )}
      <AvatarFallback delayMs={agent.avatarUrl ? delayMs : undefined}>
        <Bot className="size-3/5 text-muted-foreground" />
      </AvatarFallback>
    </Avatar>
  );
}
