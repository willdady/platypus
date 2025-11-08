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
import { type Tool, type Agent, type Model } from "@agent-kit/schemas";

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
  const [models, setModels] = useState<Model[]>([]);
  const [formData, setFormData] = useState({
    name: "",
    systemPrompt: "",
    modelId: "",
    maxSteps: 10,
    temperature: undefined,
    tools: [] as string[],
    topP: undefined,
    topK: undefined,
  });
  const [isSubmitting, setIsSubmitting] = useState(false);

  const router = useRouter();

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    const { id, value } = e.target;
    setFormData((prevData) => ({
      ...prevData,
      [id]: value,
    }));
  };

  const handleSelectChange = (id: string, value: string) => {
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

  useEffect(() => {
    const fetchData = async () => {
      const [toolsResponse, modelsResponse] = await Promise.all([
        fetch(`${process.env.NEXT_PUBLIC_BACKEND_URL}/tools`),
        fetch(`${process.env.NEXT_PUBLIC_BACKEND_URL}/models`),
      ]);

      const toolsData = await toolsResponse.json();
      setTools(toolsData.results);

      const modelsData = await modelsResponse.json();
      setModels(modelsData.results);
    };
    fetchData();
  }, []);

  const handleSubmit = async () => {
    setIsSubmitting(true);
    try {
      const payload: Omit<Agent, "id" | "createdAt" | "updatedAt"> = {
        workspaceId,
        name: formData.name,
        systemPrompt: formData.systemPrompt,
        modelId: formData.modelId,
        maxSteps: formData.maxSteps,
        temperature: formData.temperature,
        topP: formData.topP,
        topK: formData.topK,
      };

      const response = await fetch(`${process.env.NEXT_PUBLIC_BACKEND_URL}/agents`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });

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
            <Select value={formData.modelId} onValueChange={(value) => handleSelectChange("modelId", value)} disabled={isSubmitting}>
              <SelectTrigger disabled={isSubmitting}>
                <SelectValue placeholder="Select a model" />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectLabel>Models</SelectLabel>
                  {models.map((model) => (
                    <SelectItem key={model.id} value={model.id}>
                      {model.id}
                    </SelectItem>
                  ))}
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

        <FieldSet>
          <FieldLegend variant="label">Tools</FieldLegend>
          <FieldGroup className="grid grid-cols-2 gap-4">
            {tools.map((t: Tool) => (
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
                  value={formData.temperature}
                  onChange={(e) => handleFloatChange("temperature", e.target.value)}
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

      <Button className="cursor-pointer" onClick={handleSubmit} disabled={isSubmitting}>
        Save
      </Button>
    </div>
  );
};

export { AgentForm };
