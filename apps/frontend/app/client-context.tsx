"use client";

import { createContext, useContext, ReactNode } from "react";

const ConfigContext = createContext<string>("");

export default function ClientProvider({
  backendUrl,
  children,
}: {
  backendUrl: string;
  children: ReactNode;
}) {
  return (
    <ConfigContext.Provider value={backendUrl}>
      {children}
    </ConfigContext.Provider>
  );
}

// Custom hook for child components to use
export const useBackendUrl = () => useContext(ConfigContext);
