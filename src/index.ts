import { Hono } from 'hono';

const app = new Hono<{ Bindings: Env }>();

app.get('/', (c) => c.text('Flow Tracker'));

export default app;
