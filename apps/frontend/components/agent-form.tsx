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
import { useState, useEffect } from "react";
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
import { type Tool, type Agent, type Provider } from "@agent-kit/schemas";
import useSWR from "swr";
import { fetcher } from "@/lib/utils";

const BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_URL;

const AgentForm = ({
  classNames,
  orgId,
  workspaceId,
  tools,
}: {
  classNames?: string;
  orgId: string;
  workspaceId: string;
  tools: Tool[];
}) => {
  const [isOpen, setIsOpen] = useState(false);

  // Fetch providers
  const { data: providersData } = useSWR<{ results: Provider[] }>(
    `${BACKEND_URL}/providers?workspaceId=${workspaceId}`,
    fetcher,
  );
  const providers = providersData?.results || [];

  const [formData, setFormData] = useState({
    name: "",
    systemPrompt: "",
    providerId: "",
    modelId: "",
    maxSteps: 10,
    temperature: undefined,
    tools: [] as string[],
    topP: undefined,
    topK: undefined,
    seed: undefined,
  });
  const [isSubmitting, setIsSubmitting] = useState(false);

  const router = useRouter();

  // Initialize with first provider's first model once providers are loaded
  useEffect(() => {
    if (providers.length > 0 && !formData.modelId && !formData.providerId) {
      setFormData((prevData) => ({
        ...prevData,
        modelId: providers[0].modelIds[0],
        providerId: providers[0].id,
      }));
    }
  }, [providers, formData.modelId, formData.providerId]);

  const handleChange = (
    e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>,
  ) => {
    const { id, value } = e.target;
    setFormData((prevData) => ({
      ...prevData,
      [id]: value,
    }));
  };

  const handleNumberChange = (id: string, value: string) => {
    setFormData((prevData) => ({
      ...prevData,
      [id]: parseInt(value),
    }));
  };

  const handleFloatChange = (id: string, value: string) => {
    setFormData((prevData) => ({
      ...prevData,
      [id]: parseFloat(value),
    }));
  };

  const handleModelChange = (value: string) => {
    // Value is in format "providerId:modelId"
    const [newProviderId, newModelId] = value.split(":");
    if (newProviderId && newModelId) {
      setFormData((prevData) => ({
        ...prevData,
        providerId: newProviderId,
        modelId: newModelId,
      }));
    }
  };

  const handleSubmit = async () => {
    setIsSubmitting(true);
    try {
      const payload: Omit<Agent, "id" | "createdAt" | "updatedAt"> = {
        workspaceId,
        providerId: formData.providerId,
        name: formData.name,
        systemPrompt: formData.systemPrompt,
        modelId: formData.modelId,
        maxSteps: formData.maxSteps,
        temperature: formData.temperature,
        topP: formData.topP,
        topK: formData.topK,
        seed: formData.seed,
      };

      const response = await fetch(
        `${process.env.NEXT_PUBLIC_BACKEND_URL}/agents`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify(payload),
        },
      );

      if (response.ok) {
        router.push(`/${orgId}/workspace/${workspaceId}`);
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
              value={formData.name}
              onChange={handleChange}
              disabled={isSubmitting}
            />
            {/* <FieldError>Validation message.</FieldError> */}
          </Field>
          <Field>
            <FieldLabel htmlFor="systemPrompt">System prompt</FieldLabel>
            <Textarea
              id="systemPrompt"
              placeholder="You are a helpful agent..."
              value={formData.systemPrompt}
              onChange={handleChange}
              disabled={isSubmitting}
            />
          </Field>
          <Field>
            <FieldLabel>Model</FieldLabel>
            <Select
              value={`${formData.providerId}:${formData.modelId}`}
              onValueChange={handleModelChange}
              disabled={isSubmitting}
            >
              <SelectTrigger disabled={isSubmitting}>
                <SelectValue placeholder="Select a model" />
              </SelectTrigger>
              <SelectContent>
                {providers.map((provider) => (
                  <SelectGroup key={provider.id}>
                    <SelectLabel>{provider.name}</SelectLabel>
                    {provider.modelIds.map((modelId) => (
                      <SelectItem
                        key={`${provider.id}:${modelId}`}
                        value={`${provider.id}:${modelId}`}
                      >
                        {modelId}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field className="w-1/2">
            <FieldLabel htmlFor="maxSteps">Max steps</FieldLabel>
            <Input
              id="maxSteps"
              type="number"
              min="1"
              value={formData.maxSteps}
              onChange={(e) => handleNumberChange("maxSteps", e.target.value)}
              disabled={isSubmitting}
            />
            <FieldDescription>
              Controls when a tool-calling loop should stop based on the number
              of steps executed
            </FieldDescription>
          </Field>
        </FieldGroup>

        {(() => {
          // Group tools by category
          const toolsByCategory = tools.reduce(
            (acc, tool) => {
              const category = tool.category || "Uncategorized";
              if (!acc[category]) {
                acc[category] = [];
              }
              acc[category].push(tool);
              return acc;
            },
            {} as Record<string, Tool[]>,
          );

          // Sort categories alphabetically, but keep "Uncategorized" last
          const sortedCategories = Object.keys(toolsByCategory).sort((a, b) => {
            if (a === "Uncategorized") return 1;
            if (b === "Uncategorized") return -1;
            return a.localeCompare(b);
          });

          return sortedCategories.map((category) => (
            <FieldSet key={category}>
              <FieldLegend variant="label">{category}</FieldLegend>
              <FieldGroup className="grid grid-cols-2 gap-4">
                {toolsByCategory[category].map((t: Tool) => (
                  <Field key={t.id} orientation="horizontal">
                    <Switch
                      id={t.id}
                      className="cursor-pointer"
                      checked={formData.tools.includes(t.id)}
                      onCheckedChange={(checked) => {
                        setFormData((prevData) => {
                          const newSelectedTools = checked
                            ? [...prevData.tools, t.id]
                            : prevData.tools.filter((id) => id !== t.id);
                          return { ...prevData, tools: newSelectedTools };
                        });
                      }}
                      disabled={isSubmitting}
                    />
                    <FieldLabel htmlFor={t.id}>
                      <div className="flex flex-col">
                        <p>{t.id}</p>
                        <p className="text-xs text-muted-foreground">
                          {t.description}
                        </p>
                      </div>
                    </FieldLabel>
                  </Field>
                ))}
              </FieldGroup>
            </FieldSet>
          ));
        })()}

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
            <FieldGroup className="grid grid-cols-2 gap-4">
              <Field>
                <FieldLabel htmlFor="temperature">Temperature</FieldLabel>
                <Input
                  id="temperature"
                  type="number"
                  min="0"
                  step="0.1"
                  value={formData.temperature}
                  onChange={(e) =>
                    handleFloatChange("temperature", e.target.value)
                  }
                  disabled={isSubmitting}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="seed">Seed</FieldLabel>
                <Input
                  id="seed"
                  type="number"
                  value={formData.seed}
                  onChange={(e) => handleNumberChange("seed", e.target.value)}
                  disabled={isSubmitting}
                />
                <FieldDescription>
                  Random seed for deterministic generation
                </FieldDescription>
              </Field>
              <Field>
                <FieldLabel htmlFor="topP">Top-p</FieldLabel>
                <Input
                  id="topP"
                  type="number"
                  min="0"
                  max="1"
                  step="0.1"
                  value={formData.topP}
                  onChange={(e) => handleFloatChange("topP", e.target.value)}
                  disabled={isSubmitting}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="topK">Top-k</FieldLabel>
                <Input
                  id="topK"
                  type="number"
                  min="1"
                  value={formData.topK}
                  onChange={(e) => handleNumberChange("topK", e.target.value)}
                  disabled={isSubmitting}
                />
              </Field>
            </FieldGroup>
          </CollapsibleContent>
        </Collapsible>
      </FieldSet>

      <Button
        className="cursor-pointer"
        onClick={handleSubmit}
        disabled={isSubmitting}
      >
        Save
      </Button>
    </div>
  );
};

export { AgentForm };
