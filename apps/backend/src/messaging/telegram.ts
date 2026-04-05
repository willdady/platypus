import { Bot } from "grammy";
import type {
  MessagingProvider,
  MessageHandler,
  CommandHandler,
  IncomingMessage,
  OutgoingMessage,
} from "./types.ts";
import { logger } from "../logger.ts";

const TELEGRAM_MAX_MESSAGE_LENGTH = 4096;

/**
 * Wraps native fetch for compatibility with grammY.
 * grammY uses the `abort-controller` polyfill whose AbortSignal is not
 * accepted by Node.js's native fetch (undici). This wrapper creates a
 * native AbortController and forwards the abort event from the polyfill signal.
 * It also strips node-fetch-specific options like `agent` and `compress`.
 */
function grammyFetch(
  url: string | URL | Request,
  init?: RequestInit & Record<string, unknown>,
): Promise<Response> {
  const { signal, agent, compress, ...rest } = (init ?? {}) as any;

  const nativeController = new AbortController();

  if (signal) {
    if (signal.aborted) {
      nativeController.abort(signal.reason);
    } else {
      signal.addEventListener("abort", () => {
        nativeController.abort(signal.reason);
      });
    }
  }

  return globalThis.fetch(url, {
    ...rest,
    signal: nativeController.signal,
  });
}

/**
 * Splits a long message into chunks that fit within Telegram's message limit.
 * Prefers splitting at newline or space boundaries.
 */
function splitMessage(text: string): string[] {
  if (text.length <= TELEGRAM_MAX_MESSAGE_LENGTH) {
    return [text];
  }

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= TELEGRAM_MAX_MESSAGE_LENGTH) {
      chunks.push(remaining);
      break;
    }

    let splitIndex = TELEGRAM_MAX_MESSAGE_LENGTH;

    // Try to find a newline to split at
    const newlineIndex = remaining.lastIndexOf(
      "\n",
      TELEGRAM_MAX_MESSAGE_LENGTH,
    );
    if (newlineIndex > TELEGRAM_MAX_MESSAGE_LENGTH * 0.5) {
      splitIndex = newlineIndex + 1;
    } else {
      // Try to find a space to split at
      const spaceIndex = remaining.lastIndexOf(
        " ",
        TELEGRAM_MAX_MESSAGE_LENGTH,
      );
      if (spaceIndex > TELEGRAM_MAX_MESSAGE_LENGTH * 0.5) {
        splitIndex = spaceIndex + 1;
      }
    }

    chunks.push(remaining.substring(0, splitIndex));
    remaining = remaining.substring(splitIndex);
  }

  return chunks;
}

export class TelegramProvider implements MessagingProvider {
  readonly type = "telegram";

  private bot: Bot;
  private running = false;
  private messageHandler: MessageHandler | null = null;
  private commandHandlers = new Map<string, CommandHandler>();

  constructor(botToken: string) {
    this.bot = new Bot(botToken, {
      client: {
        fetch: grammyFetch as any,
        baseFetchConfig: {},
        timeoutSeconds: 30,
      },
    });

    // Global error handler — required by grammY to prevent silent failures
    this.bot.catch((err) => {
      logger.error(
        { error: err.error, message: err.message },
        "Telegram bot error",
      );
    });

    this.setupHandlers();
  }

  private setupHandlers(): void {
    // Register command handlers with grammY
    // We use a middleware that catches all commands
    this.bot.on("message:text", async (ctx) => {
      const text = ctx.message.text;
      const chatId = ctx.chat.id.toString();
      const userId = ctx.from.id.toString();
      const username = ctx.from.username;

      const incoming: IncomingMessage = {
        externalChatId: chatId,
        externalUserId: userId,
        externalUsername: username,
        text,
      };

      // Check if it's a command
      if (text.startsWith("/")) {
        const parts = text.split(/\s+/);
        const command = parts[0].substring(1).split("@")[0]; // Remove / prefix and @botname
        const args = parts.slice(1).join(" ");

        const handler = this.commandHandlers.get(command);
        if (handler) {
          try {
            const response = await handler(command, args, incoming);
            if (response) {
              await this.sendMessage({
                externalChatId: chatId,
                text: response,
              });
            }
          } catch (error) {
            logger.error(
              { error, command, chatId },
              "Error handling Telegram command",
            );
            await ctx.reply(
              "An error occurred while processing your command. Please try again.",
            );
          }
          return;
        }
      }

      // Regular message
      if (this.messageHandler) {
        try {
          const response = await this.messageHandler(incoming);
          if (response) {
            await this.sendMessage({ externalChatId: chatId, text: response });
          }
        } catch (error) {
          logger.error({ error, chatId }, "Error handling Telegram message");
          await ctx.reply(
            "An error occurred while processing your message. Please try again.",
          );
        }
      }
    });
  }

  async start(): Promise<void> {
    if (this.running) return;

    logger.info("Starting Telegram bot long polling");
    this.running = true;

    // Verify bot token before starting long polling
    try {
      const testUrl = `https://api.telegram.org/bot${this.bot.token}/getMe`;
      const res = await globalThis.fetch(testUrl);
      const data = await res.json();
      if (!data.ok) {
        throw new Error(`Telegram API error: ${data.description}`);
      }
      logger.info({ botUsername: data.result.username }, "Telegram bot token verified");

      // Register bot commands so the Telegram menu stays in sync
      await this.bot.api.setMyCommands([
        { command: "new", description: "Start a new chat session" },
        { command: "agent", description: "List or switch agents" },
        { command: "help", description: "Show available commands" },
      ]);
    } catch (error: any) {
      this.running = false;
      logger.error(
        { error: error?.message },
        "Failed to verify Telegram bot token",
      );
      throw error;
    }

    // Start long polling in background
    this.bot
      .start({
        drop_pending_updates: true,
        onStart: (botInfo) => {
          logger.info(
            { botUsername: botInfo.username },
            "Telegram bot polling started",
          );
        },
      })
      .catch((error) => {
        this.running = false;
        logger.error({ error }, "Telegram bot polling stopped unexpectedly");
      });
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    await this.bot.stop();
    logger.info("Telegram bot stopped");
  }

  isRunning(): boolean {
    return this.running;
  }

  onMessage(handler: MessageHandler): void {
    this.messageHandler = handler;
  }

  onCommand(command: string, handler: CommandHandler): void {
    this.commandHandlers.set(command, handler);
  }

  sendTypingIndicator(externalChatId: string): () => void {
    const chatId = externalChatId;
    let stopped = false;

    const send = () => {
      if (stopped) return;
      this.bot.api.sendChatAction(chatId, "typing").catch(() => {});
    };

    // Send immediately, then repeat every 4s (Telegram typing expires after ~5s)
    send();
    const interval = setInterval(send, 4000);

    return () => {
      stopped = true;
      clearInterval(interval);
    };
  }

  async sendMessage(message: OutgoingMessage): Promise<void> {
    const chunks = splitMessage(message.text);
    for (const chunk of chunks) {
      try {
        await this.bot.api.sendMessage(message.externalChatId, chunk, {
          parse_mode: "Markdown",
        });
      } catch {
        // Telegram rejects malformed Markdown — fall back to plain text
        await this.bot.api.sendMessage(message.externalChatId, chunk);
      }
    }
  }
}
