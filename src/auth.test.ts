import { describe, it, expect } from 'vitest';
import { emailGuard } from './auth';

describe('emailGuard', () => {
	it('allows the explicit owner address', () => {
		expect(emailGuard('vsr19882026@gmail.com')).toBeNull();
	});

	it('allows any address at an allowed domain', () => {
		expect(emailGuard('alice@shravyalabs.com')).toBeNull();
		expect(emailGuard('bob@shravyalabs.com')).toBeNull();
	});

	it('is case-insensitive for both the address and the domain', () => {
		expect(emailGuard('VSR19882026@Gmail.com')).toBeNull();
		expect(emailGuard('Alice@ShravyaLabs.com')).toBeNull();
	});

	it('trims surrounding whitespace before checking', () => {
		expect(emailGuard('  carol@shravyalabs.com  ')).toBeNull();
	});

	it('blocks an address at a disallowed domain with 403', async () => {
		const res = emailGuard('intruder@evil.com');
		expect(res).not.toBeNull();
		expect(res!.status).toBe(403);
		expect(await res!.json()).toEqual({ error: 'Email not allowed' });
	});

	it('does not treat a lookalike domain as allowed', () => {
		// A subdomain or suffix trick must not pass the exact-domain check.
		expect(emailGuard('mallory@evil-shravyalabs.com')).not.toBeNull();
		expect(emailGuard('mallory@shravyalabs.com.evil.com')).not.toBeNull();
	});

	it('blocks a missing or empty address with 403', () => {
		expect(emailGuard(undefined)?.status).toBe(403);
		expect(emailGuard('')?.status).toBe(403);
		expect(emailGuard('   ')?.status).toBe(403);
	});

	it('blocks a string with no domain part', () => {
		expect(emailGuard('notanemail')?.status).toBe(403);
	});
});
