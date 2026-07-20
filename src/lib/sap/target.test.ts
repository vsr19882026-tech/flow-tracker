import { env } from 'cloudflare:test';
import { beforeEach, describe, it, expect } from 'vitest';
import { resolveSapTarget, setSapMode, loadSapMode } from './target';

// The SAP target resolves from the runtime mode toggle, falling back to the env
// secrets (real) when nothing is saved.

function makeEnv(overrides: Record<string, unknown> = {}): Env {
	return { CACHE: env.CACHE, SAP_API_BASE: '', SAP_TOKEN_URL: '', ...overrides } as unknown as Env;
}

beforeEach(async () => {
	await env.CACHE.delete('sap:config');
});

describe('resolveSapTarget', () => {
	it('is off (null) when nothing is configured', async () => {
		expect(await resolveSapTarget(makeEnv())).toBeNull();
	});

	it('falls back to real from env when SAP_API_BASE is set and no mode saved', async () => {
		const target = await resolveSapTarget(makeEnv({ SAP_API_BASE: 'https://real.sap', SAP_TOKEN_URL: 'https://real.sap/token' }));
		expect(target).toEqual({ base: 'https://real.sap', tokenUrl: 'https://real.sap/token' });
	});

	it('uses the saved mock base and derives its token url in mock mode', async () => {
		const e = makeEnv({ SAP_API_BASE: 'https://real.sap' });
		await setSapMode(e, 'mock', 'https://mock.sap');
		expect(await loadSapMode(e)).toEqual({ mode: 'mock', mockBase: 'https://mock.sap' });
		expect(await resolveSapTarget(e)).toEqual({ base: 'https://mock.sap', tokenUrl: 'https://mock.sap/oauth/token' });
	});

	it('off mode disables sync even when a base secret is set', async () => {
		const e = makeEnv({ SAP_API_BASE: 'https://real.sap' });
		await setSapMode(e, 'off', null);
		expect(await resolveSapTarget(e)).toBeNull();
	});
});
