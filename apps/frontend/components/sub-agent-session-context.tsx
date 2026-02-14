"use client";

/**
 * Lightweight context that wraps each sub-agent's Chat instance in the
 * SubAgentPane. It provides the `toolCallId` so that child components
 * (specifically TaskResultTool) can identify which session they belong to
 * and call `completeSession` with the correct ID.
 */

import { createContext, useContext, type ReactNode } from "react";

interface SubAgentSessionContextType {
  toolCallId: string;
}

const SubAgentSessionContext = createContext<SubAgentSessionContextType | null>(
  null,
);

export const SubAgentSessionProvider = ({
  toolCallId,
  children,
}: {
  toolCallId: string;
  children: ReactNode;
}) => {
  return (
    <SubAgentSessionContext.Provider value={{ toolCallId }}>
      {children}
    </SubAgentSessionContext.Provider>
  );
};

export const useSubAgentSession = () => {
  const context = useContext(SubAgentSessionContext);
  if (!context) {
    throw new Error(
      "useSubAgentSession must be used within a SubAgentSessionProvider",
    );
  }
  return context;
};
