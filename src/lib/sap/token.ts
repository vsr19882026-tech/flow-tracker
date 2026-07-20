// SAP OAuth: a client-credentials bearer token, cached in KV so every outbound
// call doesn't re-authenticate. The token lives under `sap:token` with a TTL a
// minute short of the token's own expiry, so a cached token is never stale.

const TOKEN_KEY = 'sap:token';

export async function getSapToken(env: Env, tokenUrl: string = env.SAP_TOKEN_URL): Promise<string> {
	const cached = await env.CACHE.get(TOKEN_KEY);
	if (cached) return cached;

	// client_credentials grant, HTTP Basic from the client id/secret. A non-2xx
	// throws (no try/catch): the queue consumer's retry/dead-letter handles it.
	const basic = btoa(`${env.SAP_CLIENT_ID}:${env.SAP_CLIENT_SECRET}`);
	const res = await fetch(tokenUrl, {
		method: 'POST',
		headers: {
			authorization: `Basic ${basic}`,
			'content-type': 'application/x-www-form-urlencoded',
		},
		body: 'grant_type=client_credentials',
	});
	if (!res.ok) {
		throw new Error(`SAP token request failed: ${res.status}`);
	}

	const data = (await res.json()) as { access_token: string; expires_in: number };
	// KV's minimum expirationTtl is 60s; clamp so a short-lived token can't throw.
	// The cache never outlives the token: the floor (60s) is <= any expiry we clamp.
	const ttl = Math.max(60, data.expires_in - 60);
	await env.CACHE.put(TOKEN_KEY, data.access_token, { expirationTtl: ttl });
	return data.access_token;
}
