import { Hono } from 'hono';

const mcp = new Hono();

/** Create a new MCP */
mcp.post('/', (c) => c.json({ message: 'Not implemented' }, 501));

/** List all MCPs */
mcp.get('/', (c) => c.json({ message: 'Not implemented' }, 501));

/** Get a MCP by ID */
mcp.get('/:id', (c) => c.json({ message: 'Not implemented' }, 501));

/** Update a MCP by ID */
mcp.put('/:id', (c) => c.json({ message: 'Not implemented' }, 501));

/** Delete a MCP by ID */
mcp.delete('/:id', (c) => c.json({ message: 'Not implemented' }, 501));

export { mcp };