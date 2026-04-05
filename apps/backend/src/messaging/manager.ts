import { eq } from "drizzle-orm";
import { db } from "../index.ts";
import { messagingChannel as channelTable } from "../db/schema.ts";
import { TelegramProvider } from "./telegram.ts";
import {
  handleIncomingMessage,
  handleNewCommand,
  handleAgentCommand,
  handleHelpCommand,
} from "./message-handler.ts";
import {
  generatePairingCode,
  findPairedUser,
  cleanupExpiredPairings,
} from "./pairing.ts";
import type { MessagingProvider, IncomingMessage } from "./types.ts";
import { logger } from "../logger.ts";

type ChannelRecord = typeof channelTable.$inferSelect;

class MessagingProviderManager {
  private providers = new Map<string, MessagingProvider>();
  private processingLocks = new Map<string, Promise<void>>();
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;

  /**
   * Start a messaging channel by creating and starting a provider.
   */
  async startChannel(channel: ChannelRecord): Promise<void> {
    if (this.providers.has(channel.id)) {
      logger.warn(
        { channelId: channel.id },
        "Channel already running, stopping first",
      );
      await this.stopChannel(channel.id);
    }

    const provider = this.createProvider(channel);
    if (!provider) {
      logger.error(
        { channelId: channel.id, type: channel.type },
        "Unsupported channel type",
      );
      return;
    }

    // Wire up handlers
    this.wireHandlers(provider, channel);

    try {
      await provider.start();
      this.providers.set(channel.id, provider);
      logger.info(
        { channelId: channel.id, type: channel.type },
        "Messaging channel started",
      );
    } catch (error) {
      logger.error(
        { error, channelId: channel.id },
        "Failed to start messaging channel",
      );
    }
  }

  /**
   * Stop a messaging channel.
   */
  async stopChannel(channelId: string): Promise<void> {
    const provider = this.providers.get(channelId);
    if (!provider) return;

    try {
      await provider.stop();
    } catch (error) {
      logger.error({ error, channelId }, "Error stopping messaging channel");
    }
    this.providers.delete(channelId);
  }

  /**
   * Restart a channel (for config changes).
   */
  async restartChannel(channel: ChannelRecord): Promise<void> {
    await this.stopChannel(channel.id);
    await this.startChannel(channel);
  }

  /**
   * Stop all running providers.
   */
  async stopAll(): Promise<void> {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }

    const stops = Array.from(this.providers.entries()).map(
      async ([channelId, provider]) => {
        try {
          await provider.stop();
        } catch (error) {
          logger.error(
            { error, channelId },
            "Error stopping messaging channel during shutdown",
          );
        }
      },
    );

    await Promise.all(stops);
    this.providers.clear();
    logger.info("All messaging channels stopped");
  }

  /**
   * Initialize all enabled channels from the database on server startup.
   */
  async initializeFromDatabase(): Promise<void> {
    try {
      const channels = await db
        .select()
        .from(channelTable)
        .where(eq(channelTable.enabled, true));

      logger.info(
        { channelCount: channels.length },
        "Initializing messaging channels from database",
      );

      for (const channel of channels) {
        try {
          await this.startChannel(channel);
        } catch (error) {
          logger.error(
            { error, channelId: channel.id },
            "Failed to initialize messaging channel",
          );
        }
      }

      // Start periodic cleanup of expired pairings
      this.cleanupInterval = setInterval(
        async () => {
          try {
            await cleanupExpiredPairings();
          } catch (error) {
            logger.error({ error }, "Error during expired pairing cleanup");
          }
        },
        60 * 60 * 1000, // Every hour
      );
    } catch (error) {
      logger.error(
        { error },
        "Failed to initialize messaging channels from database",
      );
    }
  }

  private createProvider(channel: ChannelRecord): MessagingProvider | null {
    const config = channel.config as Record<string, unknown>;

    switch (channel.type) {
      case "telegram": {
        const botToken = config.botToken as string;
        if (!botToken) {
          logger.error({ channelId: channel.id }, "Missing bot token");
          return null;
        }
        return new TelegramProvider(botToken);
      }
      default:
        return null;
    }
  }

  private wireHandlers(
    provider: MessagingProvider,
    channel: ChannelRecord,
  ): void {
    const workspaceId = channel.workspaceId;
    const channelId = channel.id;

    /** Run a handler with sequential locking and a typing indicator. */
    const handle = (
      message: IncomingMessage,
      fn: () => Promise<string | null>,
    ): Promise<string | null> => {
      return this.withLock(message.externalChatId, async () => {
        const stopTyping = provider.sendTypingIndicator(
          message.externalChatId,
        );
        try {
          return await fn();
        } finally {
          stopTyping();
        }
      });
    };

    // Message handler
    provider.onMessage(async (message: IncomingMessage) => {
      return handle(message, () =>
        handleIncomingMessage(channelId, workspaceId, message),
      );
    });

    // /start command (Telegram-specific: shown when user first opens bot)
    provider.onCommand(
      "start",
      async (_command, _args, message: IncomingMessage) => {
        return handle(message, async () => {
          const userId = await findPairedUser(
            channelId,
            message.externalChatId,
          );

          if (userId) {
            return `Welcome back! You're already linked. Send a message to start chatting, or use /new to start a fresh session.`;
          }

          const code = await generatePairingCode(
            channelId,
            message.externalChatId,
            message.externalUserId,
            message.externalUsername,
          );

          return (
            `Welcome to Platypus!\n\n` +
            `To get started, you need to link your account.\n\n` +
            `Your pairing code is: *${code}*\n\n` +
            `Enter this code in the Messaging settings of your workspace in Platypus.\n` +
            `This code expires in 1 hour.`
          );
        });
      },
    );

    // /new command
    provider.onCommand(
      "new",
      async (_command, _args, message: IncomingMessage) => {
        return handle(message, () =>
          handleNewCommand(channelId, workspaceId, message),
        );
      },
    );

    // /agent command
    provider.onCommand(
      "agent",
      async (_command, args, message: IncomingMessage) => {
        return handle(message, () =>
          handleAgentCommand(channelId, workspaceId, args, message),
        );
      },
    );

    // /help command
    provider.onCommand("help", async () => {
      return handleHelpCommand();
    });
  }

  /**
   * Ensures messages from the same external chat are processed sequentially.
   */
  private async withLock<T>(
    externalChatId: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    const existing = this.processingLocks.get(externalChatId);

    let result: T;
    const promise = (existing ?? Promise.resolve())
      .then(async () => {
        result = await fn();
      })
      .catch((error) => {
        logger.error(
          { error, externalChatId },
          "Error in message processing lock",
        );
        throw error;
      });

    this.processingLocks.set(
      externalChatId,
      promise.catch(() => {}),
    );

    await promise;

    // Clean up lock if no one is waiting
    if (this.processingLocks.get(externalChatId) === promise.catch(() => {})) {
      this.processingLocks.delete(externalChatId);
    }

    return result!;
  }
}

export const messagingProviderManager = new MessagingProviderManager();
