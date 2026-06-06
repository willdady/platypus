import { useState } from "react";
import { useResetOnChange } from "@/hooks/use-reset-on-change";

export const useChatUI = (error: Error | undefined) => {
  const [isModelSelectorOpen, setIsModelSelectorOpen] = useState(false);
  const [isSettingsDialogOpen, setIsSettingsDialogOpen] = useState(false);
  const [isAgentInfoDialogOpen, setIsAgentInfoDialogOpen] = useState(false);
  const [isAdvancedOpen, setIsAdvancedOpen] = useState(false);
  const [isChatAdvancedOpen, setIsChatAdvancedOpen] = useState(false);
  const [showErrorDialog, setShowErrorDialog] = useState(false);
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);

  // Show error dialog when a new error arrives from useChat. Keyed on the error
  // so the user can still dismiss the dialog while the error persists.
  useResetOnChange(error, () => {
    if (error) {
      setShowErrorDialog(true);
    }
  });

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
