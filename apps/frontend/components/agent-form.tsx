"use client";

import {
  Field,
  FieldLabel,
  FieldGroup,
  FieldSet,
  FieldLegend,
  FieldDescription,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ChevronsUpDown } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { type Tool, type Agent } from "@agent-kit/schemas";

const AgentForm = ({
  classNames,
  orgId,
  workspaceId,
}: {
  classNames?: string;
  orgId: string;
  workspaceId: string;
}) => {
  const [isOpen, setIsOpen] = useState(false);

  const [tools, setTools] = useState<Tool[]>([]);
  const [name, setName] = useState("");
  const [systemPrompt, setSystemPrompt] = useState("");
  const [modelId, setModelId] = useState("");
  const [maxSteps, setMaxSteps] = useState(10);
  const [selectedTools, setSelectedTools] = useState<string[]>([]);
  const [temperature, setTemperature] = useState(1);
  const [topP, setTopP] = useState(1);
  const [topK, setTopK] = useState(50);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const router = useRouter();

  useEffect(() => {
    const fetchTools = async () => {
      const response = await fetch(
        `${process.env.NEXT_PUBLIC_BACKEND_URL}/tools`
      );
      const data = await response.json();
      setTools(data.results);
    };
    fetchTools();
  }, []);

  const handleSubmit = async () => {
    setIsSubmitting(true);
    try {
      const payload: Omit<Agent, "id" | "createdAt" | "updatedAt"> = {
        workspaceId,
        name,
        systemPrompt,
        modelId,
        maxSteps,
        temperature,
        topP,
        topK,
      };

      const response = await fetch(`${process.env.NEXT_PUBLIC_BACKEND_URL}/agents`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });

      if (response.ok) {
        router.push("/");
      } else {
        // Handle error, e.g., show a toast notification
        console.error("Failed to save agent");
      }
    } catch (error) {
      console.error("Error saving agent:", error);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className={classNames}>
      <FieldSet>
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="name">Name</FieldLabel>
            <Input
              id="name"
              placeholder="Name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={isSubmitting}
            />
            {/* <FieldError>Validation message.</FieldError> */}
          </Field>
          <Field>
            <FieldLabel htmlFor="systemPrompt">System prompt</FieldLabel>
            <Textarea
              id="systemPrompt"
              placeholder="You are a helpful agent..."
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
              disabled={isSubmitting}
            />
          </Field>
          <Field>
            <FieldLabel>Model</FieldLabel>
            <Select value={modelId} onValueChange={setModelId} disabled={isSubmitting}>
              <SelectTrigger disabled={isSubmitting}>
                <SelectValue placeholder="Select a model" />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectLabel>Models</SelectLabel>
                  <SelectItem value="gemini-pro-2.5-pro">
                    Gemini Pro 2.5 Pro
                  </SelectItem>
                  <SelectItem value="anthropic-sonnet-4.5">
                    Anthropic Sonnet 4.5
                  </SelectItem>
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>
          <Field>
            <FieldLabel htmlFor="maxSteps">Max steps</FieldLabel>
            <Input
              id="maxSteps"
              type="number"
              min="1"
              value={maxSteps}
              onChange={(e) => setMaxSteps(parseInt(e.target.value))}
              disabled={isSubmitting}
            />
            <FieldDescription>
              Controls when a tool-calling loop should stop based on the number
              of steps executed
            </FieldDescription>
          </Field>
        </FieldGroup>

        <FieldSet>
          <FieldLegend variant="label">Tools</FieldLegend>
          <FieldGroup className="grid grid-cols-2 gap-4">
            {tools.map((t: Tool) => (
              <Field key={t.id} orientation="horizontal">
                <Switch
                  id={t.id}
                  className="cursor-pointer"
                  checked={selectedTools.includes(t.id)}
                  onCheckedChange={(checked) => {
                    if (checked) {
                      setSelectedTools([...selectedTools, t.id]);
                    } else {
                      setSelectedTools(selectedTools.filter((id) => id !== t.id));
                    }
                  }}
                  disabled={isSubmitting}
                />
                <FieldLabel htmlFor={t.id}>
                  <div className="flex flex-col">
                    <p>{t.id}</p>
                    <p className="text-xs text-muted-foreground">{t.description}</p>
                  </div>
                </FieldLabel>
              </Field>
            ))}
          </FieldGroup>
        </FieldSet>

        <Collapsible open={isOpen} onOpenChange={setIsOpen}>
          <CollapsibleTrigger asChild>
            <div className="flex text-sm justify-between items-center mb-6">
              <span className="cursor-default">Advanced settings</span>
              <Button
                variant="ghost"
                size="icon"
                className="cursor-pointer size-8"
              >
                <ChevronsUpDown />
                <span className="sr-only">Toggle</span>
              </Button>
            </div>
          </CollapsibleTrigger>
          <CollapsibleContent className="mb-6">
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="temperature">Temperature</FieldLabel>
                <Input
                  id="temperature"
                  type="number"
                  min="0"
                  step="0.1"
                  value={temperature}
                  onChange={(e) => setTemperature(parseFloat(e.target.value))}
                  disabled={isSubmitting}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="topP">Top-p</FieldLabel>
                <Input
                  id="topP"
                  type="number"
                  min="0"
                  max="1"
                  step="0.1"
                  value={topP}
                  onChange={(e) => setTopP(parseFloat(e.target.value))}
                  disabled={isSubmitting}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="topK">Top-k</FieldLabel>
                <Input
                  id="topK"
                  type="number"
                  min="1"
                  value={topK}
                  onChange={(e) => setTopK(parseInt(e.target.value))}
                  disabled={isSubmitting}
                />
              </Field>
            </FieldGroup>
          </CollapsibleContent>
        </Collapsible>
      </FieldSet>

      <Button className="cursor-pointer" onClick={handleSubmit} disabled={isSubmitting}>
        Save
      </Button>
    </div>
  );
};

export { AgentForm };
