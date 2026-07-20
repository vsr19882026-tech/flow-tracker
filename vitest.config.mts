import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

export default defineWorkersConfig({
	test: {
		poolOptions: {
			workers: {
				wrangler: { configPath: './wrangler.toml' },
				// R2 presigning credentials. Prod supplies these as Worker secrets;
				// tests inject deterministic dummies (presigning only needs stable inputs).
				miniflare: {
					bindings: {
						R2_ACCOUNT_ID: 'test-account',
						R2_ACCESS_KEY_ID: 'test-key',
						R2_SECRET_ACCESS_KEY: 'test-secret',
						// Shared secret for the inbound SAP webhook HMAC (tests sign with this).
						SAP_WEBHOOK_SECRET: 'test-webhook-secret',
					},
				},
			},
		},
	},
});
