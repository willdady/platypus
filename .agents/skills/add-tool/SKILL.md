---
name: add-tool
description: Guide for adding new tools to Platypus - covers backend implementation, frontend integration, and tool registration.
---

# Adding New Tools to Platypus

This guide explains how to add custom tools that AI agents can use during chat sessions.

---

## Overview

Tools in Platypus are defined using the AI SDK's `tool()` function with three components:

- **description**: What the tool does (helps AI decide when to invoke it)
- **inputSchema**: Zod schema defining parameters with descriptions
- **execute**: Async function that performs the operation

---

## Step 1: Create Backend Tool Definition

### File Location

Create a new file in `/apps/backend/src/tools/` or add to an existing category file.

### Tool Structure

```typescript
import { tool } from "ai";
import { z } from "zod";

export const yourToolName = tool({
  description: "Clear description of what this tool does",
  inputSchema: z.object({
    parameterName: z.string().describe("Description for AI context"),
    optionalParam: z.number().optional().describe("Optional parameter"),
  }),
  execute: async ({ parameterName, optionalParam }) => {
    // Implement your logic here
    const result = performOperation(parameterName, optionalParam);

    // Return results as an object
    return { result };
  },
});
```

### Real Example: Temperature Conversion

```typescript
// apps/backend/src/tools/math.ts
export const convertFahrenheitToCelsius = tool({
  description: "Convert temperature from Fahrenheit to Celsius",
  inputSchema: z.object({
    temperature: z.number().describe("Temperature in Fahrenheit"),
  }),
  execute: async ({ temperature }) => {
    const celsius = Math.round((temperature - 32) * (5 / 9));
    return { celsius };
  },
});
```

### Tool Best Practices

1. **Descriptive names**: Use clear, action-oriented names (e.g., `getCurrentTime`, not `time`)
2. **Rich descriptions**: Help the AI understand when to use the tool
3. **Parameter descriptions**: Use `.describe()` on each schema field
4. **Error handling**: Wrap logic in try-catch and return error objects
5. **Return objects**: Always return structured data, not primitives

---

## Step 2: Register Tool in Tool Set

### File Location

Edit `/apps/backend/src/tools/index.ts`

### Registration Pattern

```typescript
import { yourToolName, anotherTool } from "./your-file.ts";

// Register a new tool set
registerToolSet("tool-set-id", {
  name: "Display Name",
  category: "Category Name",
  description: "Optional description of the tool set",
  tools: {
    yourToolName,
    anotherTool,
  },
});
```

### Real Example: Time Tools

```typescript
// apps/backend/src/tools/index.ts
import { getCurrentTime, convertTimezone } from "./time.ts";

registerToolSet("time", {
  name: "Time",
  category: "Utilities",
  description:
    "Tools for getting current time and converting between timezones",
  tools: {
    getCurrentTime,
    convertTimezone,
  },
});
```

### Tool Set Guidelines

- **ID**: Use kebab-case (e.g., `math-conversions`, `time`)
- **Category**: Groups tool sets in UI (e.g., "Math", "Utilities", "Elicitation")
- **Related tools**: Group related functionality in one tool set
- **Description**: Optional but helpful for users selecting tools

---

## Step 3: Frontend Integration (Automatic)

The frontend automatically displays new tools once registered. No code changes needed!

Tools render with default JSON formatting for input/output. For custom UI (interactive elements, special formatting), see "Advanced Patterns" section below.

### Where Tools Appear

1. **Agent Creation/Edit Form**
   - Tools grouped by category
   - 2-column grid with toggle switches
   - Shows name and description

2. **Agent List View**
   - Shows tool count with wrench icon
   - Hover to see tool set names

3. **Agent Info Dialog**
   - Displays assigned tools as badges

4. **Chat Interface**
   - Real-time tool execution display
   - Status indicators (pending, running, completed, error)
   - Input/output JSON rendering

### Tool Display Example

When you register `math-conversions` tool set:

- **Category**: "Math"
- **Display**: "Math Conversions" with description
- **Assignment**: Users toggle switch to assign to agents
- **Chat**: Shows "convertFahrenheitToCelsius" executing during chat

---

## Step 4: Test Your Tool

### 1. Restart Backend

```bash
# Stop current dev server (Ctrl+C)
pnpm dev
```

### 2. Create Test Agent

1. Navigate to workspace
2. Click "Create Agent"
3. Enable your new tool set
4. Save agent

### 3. Test in Chat

Start a chat and ask the agent to use your tool:

```
User: "Convert 75 Fahrenheit to Celsius"
Agent: [Uses convertFahrenheitToCelsius tool]
Result: { "celsius": 24 }
```

---

## Advanced Patterns

### 1. Dynamic/Workspace-Scoped Tools

For tools that need workspace-specific data:

```typescript
// Factory function that returns a tool
export const createLoadSkillTool = (workspaceId: string) => {
  return tool({
    description: `Load a skill definition for workspace ${workspaceId}`,
    inputSchema: z.object({
      name: z.string().describe("Skill name"),
    }),
    execute: async ({ name }) => {
      // Access workspace-specific data
      const skill = await db
        .select()
        .from(skillTable)
        .where(eq(skillTable.workspaceId, workspaceId))
        .limit(1);

      return { skill };
    },
  });
};
```

### 2. Tools with Database Access

Pass database instance via closure or import shared connection:

```typescript
import { db } from "../db/index.ts";
import { userTable } from "../db/schema.ts";
import { eq } from "drizzle-orm";

export const getUserInfo = tool({
  description: "Get user information by ID",
  inputSchema: z.object({
    userId: z.string().describe("User ID"),
  }),
  execute: async ({ userId }) => {
    const user = await db
      .select()
      .from(userTable)
      .where(eq(userTable.id, userId))
      .limit(1);

    return { user: user[0] || null };
  },
});
```

### 3. Tools with External API Calls

```typescript
export const fetchWeather = tool({
  description: "Get current weather for a location",
  inputSchema: z.object({
    city: z.string().describe("City name"),
    country: z.string().optional().describe("Country code (e.g., US)"),
  }),
  execute: async ({ city, country }) => {
    try {
      const response = await fetch(
        `https://api.weather.com?city=${city}&country=${country}`,
      );
      const data = await response.json();
      return { weather: data };
    } catch (error) {
      return { error: "Failed to fetch weather data" };
    }
  },
});
```

### 4. User Interaction Tools

For tools that need user input during execution:

```typescript
// apps/backend/src/tools/elicitation.ts
export const askFollowupQuestion = tool({
  description: "Ask the user a follow-up question...",
  inputSchema: z.object({
    question: z.string().describe("The question to ask"),
    followUp: z.array(z.string()).optional().describe("Suggested answers"),
  }),
  execute: async ({ question, followUp }) => {
    // Tool execution triggers UI in frontend
    // Frontend components/ask-followup-question-tool.tsx handles display
    return { asked: true };
  },
});
```

### 5. Custom Tool UI Components (Optional)

By default, tools display input/output as formatted JSON. For better UX, you can create custom React components.

**When to use custom UI:**

- Interactive elements (buttons, clickable suggestions)
- Special formatting (images, charts, structured data)
- User interaction during execution

**How it works:**

The `ChatMessage` component checks tool types and renders custom components:

```typescript
// apps/frontend/components/chat-message.tsx (lines 197-229)
else if (part.type === "tool-askFollowupQuestion") {
  return (
    <AskFollowupQuestionTool
      key={`${message.id}-${i}`}
      toolPart={part as ToolUIPart}
      onAppendToPrompt={onAppendToPrompt}
      onSubmitMessage={onSubmitMessage}
      messageId={message.id}
      role={message.role}
      index={i}
    />
  );
} else if (part.type.startsWith("tool-")) {
  // Default: generic tool rendering with JSON
  const toolPart = part as ToolUIPart;
  return (
    <Tool key={`${message.id}-${i}`}>
      <ToolHeader state={toolPart.state} type={toolPart.type} />
      <ToolContent>
        <ToolInput input={toolPart.input} />
        <ToolOutput output={toolPart.output} errorText={toolPart.errorText} />
      </ToolContent>
    </Tool>
  );
}
```

**Real Example: AskFollowupQuestionTool**

```typescript
// apps/frontend/components/ask-followup-question-tool.tsx
export const AskFollowupQuestionTool = ({
  toolPart,
  onAppendToPrompt,
  onSubmitMessage,
  messageId,
  role,
  index,
}: AskFollowupQuestionToolProps) => {
  const input = toolPart.input as PlatypusTools["askFollowupQuestion"]["input"];

  // Handle error state
  if (toolPart.state === "output-error") {
    return <div className="text-destructive">Error: {toolPart.errorText}</div>;
  }

  // Handle streaming state
  if (!input?.question && toolPart.state === "input-streaming") {
    return <Loader2Icon className="animate-spin" />;
  }

  // Render custom UI with clickable suggestions
  return (
    <Message from={role}>
      <MessageContent>
        <MessageResponse>{input.question}</MessageResponse>
        {input.followUp?.map((text, idx) => (
          <Item
            key={idx}
            className="cursor-pointer"
            onClick={() => onSubmitMessage?.(text)}
          >
            <ItemTitle>{text}</ItemTitle>
            <MessageAction onClick={() => onAppendToPrompt?.(text)}>
              <ClipboardPasteIcon />
            </MessageAction>
          </Item>
        ))}
      </MessageContent>
    </Message>
  );
};
```

**Steps to add custom tool UI:**

1. **Create component** in `/apps/frontend/components/your-tool.tsx`
2. **Add conditional rendering** in `/apps/frontend/components/chat-message.tsx`:
   ```typescript
   else if (part.type === "tool-yourToolName") {
     return <YourToolComponent toolPart={part as ToolUIPart} />;
   }
   ```
3. **Import component** at top of `chat-message.tsx`
4. **Handle tool states**: `input-streaming`, `input-available`, `output-available`, `output-error`

**Existing custom tool components:**

- `AskFollowupQuestionTool` - Interactive question suggestions
- `LoadSkillTool` - Skill loading status display

---

## Tool Categories Reference

Current categories used in Platypus:

- **Math**: Mathematical operations and conversions
- **Utilities**: General-purpose tools (time, formatting, etc.)
- **Elicitation**: Tools for gathering user information
- **MCP**: Model Context Protocol integrations (dynamic)
- **Uncategorized**: Default for tools without category

Choose an existing category or create a new one as needed.

---

## Tool Set vs Individual Tools

**Tool Set**: A collection of related tools registered together

- Example: `math-conversions` contains `convertFahrenheitToCelsius` and `convertCelsiusToFahrenheit`

**Individual Tool**: A single executable function

- Example: `convertFahrenheitToCelsius` is one tool within the set

**Assignment**: Agents are assigned entire tool sets, not individual tools.

---

## Troubleshooting

### Tool Not Appearing in UI

1. Check tool set is registered in `/apps/backend/src/tools/index.ts`
2. Verify no registration errors (duplicate IDs throw errors)
3. Restart backend server
4. Check browser console for API errors

### Tool Not Executing

1. Verify agent has tool set assigned (`agent.toolSetIds`)
2. Check tool description is clear for AI to understand when to use it
3. Review parameter descriptions in `inputSchema`
4. Check backend logs for execution errors

### Tool Returning Errors

1. Add error handling in `execute` function
2. Return error objects: `{ error: "Error message" }`
3. Check parameter validation (Zod schema)
4. Review backend logs for stack traces

---

## Complete Example: Adding a Currency Converter

### 1. Create Tool File

```typescript
// apps/backend/src/tools/currency.ts
import { tool } from "ai";
import { z } from "zod";

export const convertCurrency = tool({
  description:
    "Convert amount from one currency to another using live exchange rates",
  inputSchema: z.object({
    amount: z.number().describe("Amount to convert"),
    from: z.string().describe("Source currency code (e.g., USD)"),
    to: z.string().describe("Target currency code (e.g., EUR)"),
  }),
  execute: async ({ amount, from, to }) => {
    try {
      // Example: Call exchange rate API
      const rate = await fetchExchangeRate(from, to);
      const converted = amount * rate;

      return {
        original: { amount, currency: from },
        converted: { amount: converted, currency: to },
        rate,
      };
    } catch (error) {
      return { error: "Failed to convert currency" };
    }
  },
});

async function fetchExchangeRate(from: string, to: string): Promise<number> {
  // Implementation details
  return 1.09; // Example rate
}
```

### 2. Register Tool Set

```typescript
// apps/backend/src/tools/index.ts
import { convertCurrency } from "./currency.ts";

registerToolSet("currency", {
  name: "Currency Converter",
  category: "Finance",
  description: "Convert between different currencies using live rates",
  tools: {
    convertCurrency,
  },
});
```

### 3. Test

```bash
pnpm dev
```

Create an agent, enable "Currency Converter", and test:

```
User: "How much is 100 USD in EUR?"
Agent: [Uses convertCurrency tool]
Result: { "converted": { "amount": 109, "currency": "EUR" }, "rate": 1.09 }
```

---

## Key Files Reference

| File                                                      | Purpose                                           |
| --------------------------------------------------------- | ------------------------------------------------- |
| `apps/backend/src/tools/index.ts`                         | Tool set registry and registration                |
| `apps/backend/src/tools/*.ts`                             | Individual tool implementations                   |
| `apps/backend/src/routes/chat.ts`                         | Tool loading and execution logic                  |
| `apps/backend/src/routes/tool.ts`                         | API endpoint for listing tools                    |
| `packages/schemas/index.ts`                               | ToolSet and Tool schemas                          |
| `apps/frontend/components/agent-form.tsx`                 | Tool assignment UI                                |
| `apps/frontend/components/chat-message.tsx`               | Tool rendering logic and custom component routing |
| `apps/frontend/components/ai-elements/tool.tsx`           | Default tool execution display components         |
| `apps/frontend/components/ask-followup-question-tool.tsx` | Custom UI for followup questions tool             |
| `apps/frontend/components/load-skill-tool.tsx`            | Custom UI for skill loading tool                  |

---

## Next Steps

After adding your tool:

1. Consider writing tests in `apps/backend/src/tools/__tests__/`
2. Document complex tools with JSDoc comments
3. Add Bruno API tests in `apps/backend/bruno/`
4. Create custom frontend UI if needed (see "Advanced Patterns" section above)
   - Reference `ask-followup-question-tool.tsx` for interactive examples
   - Reference `load-skill-tool.tsx` for status display examples

---

## Resources

- [AI SDK Tools Documentation](https://sdk.vercel.ai/docs/ai-sdk-core/tools-and-tool-calling)
- [Zod Schema Documentation](https://zod.dev)
- Platypus examples: `/apps/backend/src/tools/`
