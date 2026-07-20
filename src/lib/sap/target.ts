// The SAP sync target, selected by a runtime mode toggle (admin UI). The mode is
// stored in KV so it can be flipped without a redeploy:
//   off  → sync disabled (no target)
//   mock → the mock-sap Worker (base from the config, or SAP_API_BASE); token at
//          <base>/oauth/token
//   real → the SAP_API_BASE / SAP_TOKEN_URL secrets (dormant until they're set)
//
// With no stored config it falls back to `real` when SAP_API_BASE is set, else
// `off` — so existing behavior (and tests) hold before any toggle is saved.

export type SapMode = 'off' | 'mock' | 'real';
export type SapTarget = { base: string; tokenUrl: string };

const CONFIG_KEY = 'sap:config';

export async function loadSapMode(env: Env): Promise<{ mode: SapMode; mockBase: string | null }> {
	const raw = await env.CACHE.get(CONFIG_KEY);
	if (raw) {
		const cfg = await Promise.resolve()
			.then(() => JSON.parse(raw) as { mode?: string; mock_base?: string })
			.then(
				(v) => v,
				() => null,
			);
		if (cfg) {
			const mode: SapMode = cfg.mode === 'mock' || cfg.mode === 'real' ? cfg.mode : 'off';
			return { mode, mockBase: typeof cfg.mock_base === 'string' && cfg.mock_base.trim() !== '' ? cfg.mock_base : null };
		}
	}
	return { mode: env.SAP_API_BASE ? 'real' : 'off', mockBase: null };
}

export async function setSapMode(env: Env, mode: SapMode, mockBase: string | null): Promise<void> {
	await env.CACHE.put(CONFIG_KEY, JSON.stringify({ mode, mock_base: mockBase ?? undefined }));
}

// The effective target for the current mode, or null when sync is off / unconfigured.
export async function resolveSapTarget(env: Env): Promise<SapTarget | null> {
	const { mode, mockBase } = await loadSapMode(env);
	if (mode === 'mock') {
		const base = mockBase ?? env.SAP_API_BASE;
		return base ? { base, tokenUrl: `${base}/oauth/token` } : null;
	}
	if (mode === 'real') {
		return env.SAP_API_BASE ? { base: env.SAP_API_BASE, tokenUrl: env.SAP_TOKEN_URL } : null;
	}
	return null;
}
