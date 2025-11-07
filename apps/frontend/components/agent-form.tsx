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
import { useState } from "react";
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

const TOOLS = [
  {
    id: "tool1",
    name: "Tool 1",
  },
  {
    id: "tool2",
    name: "Tool 2",
  },
  {
    id: "tool3",
    name: "Tool 3",
  },
  {
    id: "tool4",
    name: "Tool 4",
  },
];

const AgentForm = ({ classNames }: { classNames?: string }) => {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <div className={classNames}>
      <FieldSet>
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="name">Name</FieldLabel>
            <Input id="name" placeholder="Name" />
            {/* <FieldError>Validation message.</FieldError> */}
          </Field>
          <Field>
            <FieldLabel htmlFor="system-prompt">System prompt</FieldLabel>
            <Textarea
              id="system-prompt"
              placeholder="You are a helpful agent..."
            />
          </Field>
          <Field>
            <FieldLabel>Model</FieldLabel>
            <Select>
              <SelectTrigger>
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
            <Input id="maxSteps" type="number" min="1" />
            <FieldDescription>
              Controls when a tool-calling loop should stop based on the number
              of steps executed
            </FieldDescription>
          </Field>
        </FieldGroup>

        <FieldSet>
          <FieldLegend variant="label">Tools</FieldLegend>
          <FieldGroup className="grid grid-cols-2 gap-4">
            {TOOLS.map((t) => (
              <Field key={t.id} orientation="horizontal">
                <Switch id={t.id} className="cursor-pointer" />
                <FieldLabel htmlFor={t.id} className="font-normal">
                  {t.name}
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
                <Input id="temperature" type="number" min="0" step="0.1" />
              </Field>
              <Field>
                <FieldLabel htmlFor="top-p">Top-p</FieldLabel>
                <Input id="top-p" type="number" min="0" max="1" step="0.1" />
              </Field>
              <Field>
                <FieldLabel htmlFor="top-k">Top-k</FieldLabel>
                <Input id="top-k" type="number" min="1" />
              </Field>
            </FieldGroup>
          </CollapsibleContent>
        </Collapsible>
      </FieldSet>

      <Button className="cursor-pointer">Save</Button>
    </div>
  );
};

export { AgentForm };
