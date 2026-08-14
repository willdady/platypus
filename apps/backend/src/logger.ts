import pino from "pino";
import { errorSerializers } from "./log-serializers.ts";

const isProduction = process.env.NODE_ENV === "production";

const transport = pino.transport({
  targets: [
    isProduction
      ? {
          target: "pino/file",
          options: { destination: 1 }, // Write to stdout
        }
      : {
          target: "pino-pretty",
          options: {
            colorize: true,
          },
        },
  ],
});

export const logger = pino(
  {
    level: process.env.LOG_LEVEL || "info",
    serializers: errorSerializers,
  },
  transport,
);
