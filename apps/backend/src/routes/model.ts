import { Hono } from 'hono';

const model = new Hono();

/** Create a new model */
model.post('/', (c) => c.json({ message: 'Not implemented' }, 501));

/** List all models */
model.get('/', (c) => c.json({ message: 'Not implemented' }, 501));

/** Get a model by ID */
model.get('/:id', (c) => c.json({ message: 'Not implemented' }, 501));

/** Update a model by ID */
model.put('/:id', (c) => c.json({ message: 'Not implemented' }, 501));

/** Delete a model by ID */
model.delete('/:id', (c) => c.json({ message: 'Not implemented' }, 501));

export { model };