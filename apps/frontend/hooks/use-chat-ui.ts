import { useState } from "react";
import { useResetOnChange } from "@/hooks/use-reset-on-change";
import type { ChatErrorTreatment } from "@/lib/chat-recovery";

export const useChatUI = (
  error: Error | undefined,
  /**
   * How this error should be surfaced, from `classifyChatError`. Only a
   * `failure` opens the modal: a dropped connection to a run that is still
   * going gets an inline line instead, because the turn has not failed and the
   * answer keeps filling in on its own (issue #648).
   */
  errorTreatment: ChatErrorTreatment,
) => {
  const [isSettingsDialogOpen, setIsSettingsDialogOpen] = useState(false);
  const [isAgentInfoDialogOpen, setIsAgentInfoDialogOpen] = useState(false);
  const [isAdvancedOpen, setIsAdvancedOpen] = useState(false);
  const [isChatAdvancedOpen, setIsChatAdvancedOpen] = useState(false);
  const [showErrorDialog, setShowErrorDialog] = useState(false);
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);

  // Show error dialog when a new error arrives from useChat. Keyed on the error
  // so the user can still dismiss the dialog while the error persists.
  useResetOnChange(error, () => {
    if (error && errorTreatment === "failure") {
      setShowErrorDialog(true);
    }
  });

  return {
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
