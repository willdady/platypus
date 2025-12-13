import { useState, useEffect } from "react";

export const useChatUI = (error: any) => {
  const [isModelSelectorOpen, setIsModelSelectorOpen] = useState(false);
  const [isSettingsDialogOpen, setIsSettingsDialogOpen] = useState(false);
  const [isAgentInfoDialogOpen, setIsAgentInfoDialogOpen] = useState(false);
  const [isAdvancedOpen, setIsAdvancedOpen] = useState(false);
  const [isChatAdvancedOpen, setIsChatAdvancedOpen] = useState(false);
  const [showErrorDialog, setShowErrorDialog] = useState(false);
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);

  // Show error dialog if there's an error from useChat
  useEffect(() => {
    if (error) {
      setShowErrorDialog(true);
    }
  }, [error]);

  return {
    isModelSelectorOpen,
    setIsModelSelectorOpen,
    isSettingsDialogOpen,
    setIsSettingsDialogOpen,
    isAgentInfoDialogOpen,
    setIsAgentInfoDialogOpen,
    isAdvancedOpen,
    setIsAdvancedOpen,
    isChatAdvancedOpen,
    setIsChatAdvancedOpen,
    showErrorDialog,
    setShowErrorDialog,
    copiedMessageId,
    setCopiedMessageId,
  };
};
