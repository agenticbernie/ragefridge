import test from 'node:test';
import assert from 'node:assert/strict';
import { Wallet } from 'ethers';
import { createWalletAuth } from '../server/wallet-auth.js';

test('wallet challenge is origin-bound, one-use and issues a short-lived session', async () => {
  let now = 1000;
  const wallet = Wallet.createRandom();
  const auth = createWalletAuth({ origin: 'https://game.example', now: () => now });
  assert.equal(auth.allowedOrigin({ headers: { origin: 'https://game.example', host: 'game.example', 'x-forwarded-proto': 'https' } }), true);
  assert.equal(auth.allowedOrigin({ headers: { origin: 'https://attacker.example', host: 'game.example', 'x-forwarded-proto': 'https' } }), false);
  const challenge = auth.challenge(wallet.address, 'https://game.example');
  const signature = await wallet.signMessage(challenge.message);
  const session = auth.login({ address: wallet.address, challengeId: challenge.challengeId, signature });
  assert.equal(auth.address(session.token), wallet.address);
  assert.throws(() => auth.login({ address: wallet.address, challengeId: challenge.challengeId, signature }), /Invalid/);
  now += 31 * 60 * 1000;
  assert.equal(auth.address(session.token), undefined);
});

test('wallet challenge refuses a mismatched signer and invalid address', async () => {
  const alice = Wallet.createRandom();
  const mallory = Wallet.createRandom();
  const auth = createWalletAuth({ origin: 'https://game.example' });
  assert.throws(() => auth.challenge('not-an-address', 'https://game.example'));
  const challenge = auth.challenge(alice.address, 'https://game.example');
  const signature = await mallory.signMessage(challenge.message);
  assert.throws(() => auth.login({ address: alice.address, challengeId: challenge.challengeId, signature }), /Invalid/);
});
