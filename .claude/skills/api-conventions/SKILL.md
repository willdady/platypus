# API Response Conventions

## Error Responses (4xx/5xx)

All error responses MUST use the `error` key:

```json
{ "error": "Description of what went wrong" }
```

**Correct:**

```typescript
return c.json({ error: "Card not found" }, 404);
return c.json({ error: "Invalid user assignee" }, 400);
return c.json({ error: "Not a member of this organization" }, 403);
```

**Incorrect:**

```typescript
return c.json({ message: "Card not found" }, 404); // WRONG — use "error" for errors
```

## Success Messages (2xx)

When a 2xx response returns a status message (rather than a resource), use the `message` key:

```json
{ "message": "Board deleted" }
```

## Test Assertions

- Assert errors with `body.error`:
  ```typescript
  expect(body.error).toBe("Invalid user assignee");
  ```
- Assert success messages with `body.message`:
  ```typescript
  expect(await res.json()).toEqual({ message: "Board deleted" });
  ```
