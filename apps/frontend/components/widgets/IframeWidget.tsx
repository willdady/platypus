"use client";

import { useState } from "react";
import type { IframeWidgetData, Widget } from "@platypus/schemas";
import { useResetOnChange } from "@/hooks/use-reset-on-change";
import { Button } from "@/components/ui/button";
import { FieldError } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Check } from "lucide-react";

const HTTPS_URL_ERROR = "Embed URL must use HTTPS";

/**
 * Checks the persisted or edited URL again at the browser boundary.
 */
function isHttpsUrl(value: unknown): value is string {
  return (
    typeof value === "string" && value.toLowerCase().startsWith("https://")
  );
}

/**
 * Renders a human-managed HTTPS page with fixed browser isolation attributes.
 */
export function IframeWidget({
  widget,
  editing,
  onSave,
}: {
  widget: Widget;
  editing: boolean;
  onSave: (data: object, title: string) => void;
}) {
  const data = widget.data as IframeWidgetData | null | undefined;
  const [title, setTitle] = useState(widget.title);
  const [url, setUrl] = useState(data?.url ?? "");
  const [urlError, setUrlError] = useState<string | null>(null);

  useResetOnChange(widget.title, () => setTitle(widget.title));
  useResetOnChange(data?.url, () => {
    setUrl(data?.url ?? "");
    setUrlError(null);
  });

  /**
   * Prevents an invalid URL from reaching the PATCH request and explains the
   * rejected field directly in the editor.
   */
  const handleSave = () => {
    if (!isHttpsUrl(url)) {
      setUrlError(HTTPS_URL_ERROR);
      return;
    }

    setUrlError(null);
    onSave({ url }, title);
  };

  if (editing) {
    return (
      <div className="flex h-full flex-col gap-2 p-3">
        <div className="space-y-1">
          <Label className="text-xs" htmlFor={`iframe-title-${widget.id}`}>
            Name
          </Label>
          <Input
            id={`iframe-title-${widget.id}`}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            className="h-7 text-sm"
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs" htmlFor={`iframe-url-${widget.id}`}>
            Embed URL
          </Label>
          <Input
            id={`iframe-url-${widget.id}`}
            type="url"
            value={url}
            onChange={(event) => {
              setUrl(event.target.value);
              setUrlError(null);
            }}
            placeholder="https://example.com/embed"
            className="h-7 text-sm"
            aria-invalid={!!urlError}
          />
          <FieldError className="text-xs">{urlError}</FieldError>
        </div>
        <p className="text-xs text-muted-foreground">
          Some sites don&apos;t allow embedding and will appear blank.
        </p>
        <Button size="sm" className="mt-auto" onClick={handleSave}>
          <Check className="h-3 w-3" /> Save
        </Button>
      </div>
    );
  }

  return (
    <div className="flex h-full items-center justify-center">
      {isHttpsUrl(data?.url) ? (
        <iframe
          src={data.url}
          title={widget.title}
          // No `allow-same-origin`: an Embed holds a URL a User pasted, and
          // for one on this deployment's own origin the flag would undo the
          // sandbox entirely — a same-origin framed document can drop the
          // attribute from its own frame element and reload without it. The
          // frame is kept a foreign origin whatever URL it holds, so no origin
          // comparison is needed anywhere. Costs an embed its own cookies and
          // storage.
          sandbox="allow-scripts allow-forms allow-popups"
          referrerPolicy="no-referrer"
          className="h-full w-full border-0"
        />
      ) : (
        <p className="text-sm text-muted-foreground italic">
          Add an HTTPS URL to embed a page
        </p>
      )}
    </div>
  );
}
