import { Hono } from "hono";

const model = new Hono();

/** Create a new model */
model.post("/", (c) => c.json({ message: "Not implemented" }, 501));

/** List all models */
model.get("/", async (c) => {
  // FIXME: Hard coding for now!
  return c.json(
    {
      results: [
        {
          id: "google/gemini-2.5-pro",
          name: "Gemini 2.5 Pro",
        },
        {
          id: "google/gemini-2.5-flash",
          name: "Gemini 2.5 Flash",
        },
        {
          id: "minimax/minimax-m2:free",
          name: "MiniMax M2 (free)",
        },
        {
          id: "anthropic/claude-sonnet-4.5",
          name: "Claude Sonnet 4.5",
        },
      ],
    },
    200,
  );
});

/** Get a model by ID */
model.get("/:id", (c) => c.json({ message: "Not implemented" }, 501));

/** Update a model by ID */
model.put("/:id", (c) => c.json({ message: "Not implemented" }, 501));

/** Delete a model by ID */
model.delete("/:id", (c) => c.json({ message: "Not implemented" }, 501));

export { model };
