import { env } from 'cloudflare:test';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { getSapToken } from './token';

// getSapToken authenticates once and serves the KV-cached token thereafter.

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('getSapToken', () => {
	it('1. caches the token - a second call does not re-fetch', async () => {
		const fetchMock = vi.fn(
			async () => new Response(JSON.stringify({ access_token: 'tok-abc', expires_in: 3600 }), { status: 200 }),
		);
		vi.stubGlobal('fetch', fetchMock);

		// getSapToken only reads these four; a partial env is enough.
		const testEnv = {
			CACHE: env.CACHE,
			SAP_TOKEN_URL: 'https://sap.example/oauth/token',
			SAP_CLIENT_ID: 'client',
			SAP_CLIENT_SECRET: 'secret',
		} as unknown as Env;

		const first = await getSapToken(testEnv);
		const second = await getSapToken(testEnv);

		expect(first).toBe('tok-abc');
		expect(second).toBe('tok-abc');
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
});
