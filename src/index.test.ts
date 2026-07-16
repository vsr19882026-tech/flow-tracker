import { env, createExecutionContext, waitOnExecutionContext, SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import worker from './index';

// Placeholder smoke tests that run inside the Workers runtime (miniflare) with
// bindings mocked. These exercise routes that don't require a session, so no
// D1 tables are needed — the session middleware skips the DB lookup when there
// is no cookie.
describe('flow-tracker worker', () => {
	it('GET / redirects to /sign-in when unauthenticated (unit style)', async () => {
		const request = new Request('http://example.com/');
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(302);
		expect(response.headers.get('location')).toBe('/sign-in');
	});

	it('GET /whoami returns 401 without a session (integration style)', async () => {
		const response = await SELF.fetch('http://example.com/whoami');
		expect(response.status).toBe(401);
		expect(await response.json()).toEqual({ error: 'Unauthorized' });
	});
});
