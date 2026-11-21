import { randomBytes } from 'node:crypto';
import { getAddress, verifyMessage } from 'ethers';

export function createWalletAuth({ origin, now = Date.now, capacity = 1000 } = {}) {
  const challenges = new Map();
  const sessions = new Map();
  const rates = new Map();
  const canonicalOrigin = origin ? new URL(origin).origin : null;
  function prune() {
    for (const map of [challenges, sessions, rates]) {
      for (const [key, value] of map) if (value.expires <= now()) map.delete(key);
    }
  }
  return {
    allowedOrigin(request) {
      const forwardedProto = request.headers['x-forwarded-proto']?.split(',')[0]?.trim();
      const protocol = forwardedProto === 'https' ? 'https' : 'http';
      const expected = canonicalOrigin ?? `${protocol}://${request.headers.host}`;
      try { return new URL(request.headers.origin).origin === expected; } catch { return false; }
    },
    rateLimit(ip) {
      prune();
      const current = rates.get(ip) ?? { count: 0, expires: now() + 60000 };
      if (!rates.has(ip) && rates.size >= capacity) return false;
      rates.set(ip, current);
      return ++current.count <= 30;
    },
    challenge(address, fallbackOrigin) {
      prune();
      if (challenges.size >= capacity) throw new Error('Too many wallet requests.');
      address = getAddress(address);
      const challengeId = randomBytes(32).toString('hex');
      const expires = now() + 5 * 60000;
      const message = [canonicalOrigin ?? fallbackOrigin, 'RageFridge Fuji test-credit login',
        `Address: ${address}`, 'Chain ID: 43113', `Nonce: ${challengeId}`,
        `Expires: ${new Date(expires).toISOString()}`,
        'Sign in only. This does not approve tokens or authorize transactions.'].join('\n');
      challenges.set(challengeId, { address, message, expires });
      return { challengeId, message };
    },
    login({ address, challengeId, signature }) {
      prune();
      const challenge = challenges.get(challengeId);
      challenges.delete(challengeId); // one attempt per nonce, even invalid signatures
      if (!challenge || sessions.size >= capacity || getAddress(address) !== challenge.address ||
          verifyMessage(challenge.message, signature) !== challenge.address) throw new Error('Invalid wallet login.');
      const token = randomBytes(32).toString('base64url');
      sessions.set(token, { address: challenge.address, expires: now() + 30 * 60000 });
      return { token, address: challenge.address };
    },
    address(token) {
      prune();
      return typeof token === 'string' ? sessions.get(token)?.address : undefined;
    },
  };
}
