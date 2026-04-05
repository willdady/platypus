/** Represents an incoming message from an external messaging platform */
export interface IncomingMessage {
  externalChatId: string;
  externalUserId: string;
  externalUsername?: string;
  text: string;
}

/** Represents an outgoing message to send to an external messaging platform */
export interface OutgoingMessage {
  externalChatId: string;
  text: string;
}

/** Handler callback for processing incoming messages */
export type MessageHandler = (
  message: IncomingMessage,
) => Promise<string | null>;

/** Handler callback for processing incoming commands */
export type CommandHandler = (
  command: string,
  args: string,
  message: IncomingMessage,
) => Promise<string | null>;

/** Contract that all messaging providers (Telegram, Discord, Slack) must implement */
export interface MessagingProvider {
  readonly type: string;

  /** Start listening for messages (e.g., begin long polling) */
  start(): Promise<void>;

  /** Stop listening and clean up resources */
  stop(): Promise<void>;

  /** Whether the provider is currently running */
  isRunning(): boolean;

  /** Register a handler for incoming text messages */
  onMessage(handler: MessageHandler): void;

  /** Register a handler for incoming commands (e.g., /new, /agent) */
  onCommand(command: string, handler: CommandHandler): void;

  /** Send a message to an external chat */
  sendMessage(message: OutgoingMessage): Promise<void>;

  /** Send a typing indicator to an external chat. Returns a stop function. */
  sendTypingIndicator(externalChatId: string): () => void;
}
