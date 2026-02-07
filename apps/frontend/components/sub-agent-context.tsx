"use client";

import {
  createContext,
  useContext,
  useState,
  useCallback,
  useRef,
  type ReactNode,
} from "react";

/**
 * Represents a single sub-agent delegation. Each session maps 1:1 with a
 * `newTask` tool call in the parent chat. Multiple sessions can be active
 * concurrently when the parent agent delegates to several sub-agents.
 */
export interface SubAgentSession {
  toolCallId: string;
  parentChatId: string;
  subAgentId: string;
  /** Deterministic chat ID derived from toolCallId — used as the sub-agent's chat ID. */
  subChatId: string;
  task: string;
  /** Null while the sub-agent is still running; populated when it calls taskResult. */
  result: { result: string; status: "success" | "error" } | null;
}

interface SubAgentContextType {
  sessions: Map<string, SubAgentSession>;
  activeSessionId: string | null;
  startSession: (
    parentChatId: string,
    toolCallId: string,
    subAgentId: string,
    task: string,
  ) => void;
  openSession: (toolCallId: string) => void;
  completeSession: (
    toolCallId: string,
    result: { result: string; status: "success" | "error" },
  ) => void;
  closePane: () => void;
  getSession: (toolCallId: string) => SubAgentSession | undefined;
  getCompletedSessions: () => SubAgentSession[];
  consumeSession: (toolCallId: string) => void;
  restoreSession: (
    parentChatId: string,
    toolCallId: string,
    subAgentId: string,
    task: string,
  ) => void;
  isToolCallCompleted: (toolCallId: string) => boolean;
}

const SubAgentContext = createContext<SubAgentContextType | null>(null);

/** Derives a deterministic sub-chat ID from a tool call ID. */
const toSubChatId = (toolCallId: string) => {
  // Strip "tool_newTask_" prefix if present and use just "sub_" + unique part
  const uniquePart = toolCallId.replace(/^tool_newTask_/, "");
  return `sub_${uniquePart}`;
};

export const SubAgentProvider = ({ children }: { children: ReactNode }) => {
  const [sessions, setSessions] = useState<Map<string, SubAgentSession>>(
    () => new Map(),
  );
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);

  // Tracks tool call IDs that have been fully processed (result yielded back to
  // the parent chat). This is a ref rather than state because:
  // 1. It needs to be populated synchronously by restoreSession() during the
  //    parent's hydration useEffect, before child component effects run.
  // 2. It's used as a guard to prevent re-launching completed sub-agents —
  //    a stale-by-one-render state value would cause a race condition.
  const completedToolCallsRef = useRef<Set<string>>(new Set());

  const isToolCallCompleted = useCallback((toolCallId: string) => {
    return completedToolCallsRef.current.has(toolCallId);
  }, []);

  const startSession = useCallback(
    (
      parentChatId: string,
      toolCallId: string,
      subAgentId: string,
      task: string,
    ) => {
      if (completedToolCallsRef.current.has(toolCallId)) return;
      setSessions((prev) => {
        if (prev.has(toolCallId)) return prev;
        const next = new Map(prev);
        next.set(toolCallId, {
          toolCallId,
          parentChatId,
          subAgentId,
          subChatId: toSubChatId(toolCallId),
          task,
          result: null,
        });
        return next;
      });
    },
    [],
  );

  /**
   * Restore a session from persisted chat history (e.g. page refresh).
   * Creates a session with a placeholder result so it renders as completed
   * and is skipped by the consumer effect.
   */
  const restoreSession = useCallback(
    (
      parentChatId: string,
      toolCallId: string,
      subAgentId: string,
      task: string,
    ) => {
      completedToolCallsRef.current.add(toolCallId);
      setSessions((prev) => {
        if (prev.has(toolCallId)) return prev;
        const next = new Map(prev);
        next.set(toolCallId, {
          toolCallId,
          parentChatId,
          subAgentId,
          subChatId: toSubChatId(toolCallId),
          task,
          result: { result: "", status: "success" },
        });
        return next;
      });
    },
    [],
  );

  const openSession = useCallback((toolCallId: string) => {
    setActiveSessionId(toolCallId);
  }, []);

  const completeSession = useCallback(
    (
      toolCallId: string,
      result: { result: string; status: "success" | "error" },
    ) => {
      setSessions((prev) => {
        const session = prev.get(toolCallId);
        if (!session) return prev;
        const next = new Map(prev);
        next.set(toolCallId, { ...session, result });
        return next;
      });
    },
    [],
  );

  const closePane = useCallback(() => {
    setActiveSessionId(null);
  }, []);

  const getSession = useCallback(
    (toolCallId: string) => {
      return sessions.get(toolCallId);
    },
    [sessions],
  );

  const getCompletedSessions = useCallback(() => {
    return Array.from(sessions.values()).filter((s) => s.result !== null);
  }, [sessions]);

  /** Mark a session as fully consumed (result has been fed back to the parent chat). */
  const consumeSession = useCallback((toolCallId: string) => {
    completedToolCallsRef.current.add(toolCallId);
  }, []);

  return (
    <SubAgentContext.Provider
      value={{
        sessions,
        activeSessionId,
        startSession,
        openSession,
        completeSession,
        closePane,
        getSession,
        getCompletedSessions,
        consumeSession,
        restoreSession,
        isToolCallCompleted,
      }}
    >
      {children}
    </SubAgentContext.Provider>
  );
};

export const useSubAgent = () => {
  const context = useContext(SubAgentContext);
  if (!context) {
    throw new Error("useSubAgent must be used within a SubAgentProvider");
  }
  return context;
};
