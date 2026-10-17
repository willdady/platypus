"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useRouter } from "next/navigation";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { interceptedHref } from "@/lib/unsaved-changes";

type UnsavedChangesContextValue = {
  setDirty: (key: string, dirty: boolean) => void;
  confirmDiscard: (onDiscard: () => void) => void;
};

// Set by `hardNavigate`, so the unload it starts isn't held.
let leavingDeliberately = false;

/**
 * A full document load the app chose (e.g. after deleting the Organization
 * the view is scoped to). Like `router.push`, it is never held by the
 * `beforeunload` prompt.
 */
export function hardNavigate(href: string) {
  leavingDeliberately = true;
  window.location.href = href;
}

const UnsavedChangesContext = createContext<UnsavedChangesContextValue | null>(
  null,
);

/**
 * Owns the one "Discard unsaved changes?" dialog, and while any guard is
 * dirty, the `beforeunload` prompt and the capture-phase click listener that
 * holds a same-tab link click until the user confirms. Programmatic
 * navigation (a post-save redirect, a delete) and browser Back pass through.
 */
export function UnsavedChangesProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [dirtyKeys, setDirtyKeys] = useState<ReadonlySet<string>>(new Set());
  const [pendingDiscard, setPendingDiscard] = useState<(() => void) | null>(
    null,
  );
  const isDirty = dirtyKeys.size > 0;

  useEffect(() => {
    if (!isDirty) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (leavingDeliberately) return;
      event.preventDefault();
      // Older Chromium and Safari show the prompt only with this set.
      event.returnValue = "";
    };
    const onClick = (event: MouseEvent) => {
      const href = interceptedHref(event);
      if (href === null) return;
      // Stopped in the capture phase, so Next's Link never sees the click.
      event.preventDefault();
      event.stopPropagation();
      setPendingDiscard(() => () => router.push(href));
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    document.addEventListener("click", onClick, true);
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
      document.removeEventListener("click", onClick, true);
    };
  }, [isDirty, router]);

  const value = useMemo<UnsavedChangesContextValue>(
    () => ({
      setDirty: (key, dirty) =>
        setDirtyKeys((prev) => {
          if (prev.has(key) === dirty) return prev;
          const next = new Set(prev);
          if (dirty) next.add(key);
          else next.delete(key);
          return next;
        }),
      confirmDiscard: (onDiscard) => setPendingDiscard(() => onDiscard),
    }),
    [],
  );

  return (
    <UnsavedChangesContext.Provider value={value}>
      {children}
      <ConfirmDialog
        open={pendingDiscard !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDiscard(null);
        }}
        title="Discard unsaved changes?"
        description="Your changes will be lost."
        confirmLabel="Discard"
        confirmVariant="destructive"
        cancelLabel="Keep editing"
        onConfirm={() => {
          setPendingDiscard(null);
          pendingDiscard?.();
        }}
      />
    </UnsavedChangesContext.Provider>
  );
}

/**
 * Registers a surface's dirty state with `UnsavedChangesProvider`, which
 * guards link clicks and unload while any surface is dirty. Returns
 * `confirmDiscard`, for a close the surface owns (a dialog's `onOpenChange`):
 * it runs `onDiscard` at once when clean, otherwise after the user confirms.
 * Without a provider (a test rendering a form alone) nothing is guarded.
 */
export function useUnsavedChangesGuard(isDirty: boolean) {
  const context = useContext(UnsavedChangesContext);
  const key = useId();

  useEffect(() => {
    context?.setDirty(key, isDirty);
    return () => context?.setDirty(key, false);
  }, [context, key, isDirty]);

  return useCallback(
    (onDiscard: () => void) => {
      if (isDirty && context) context.confirmDiscard(onDiscard);
      else onDiscard();
    },
    [context, isDirty],
  );
}
