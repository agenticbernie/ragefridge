import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import * as ethers from 'ethers';

const source = await readFile(new URL('../public/wallet.js', import.meta.url), 'utf8');
const address = '0x0000000000000000000000000000000000000001';
const token = '0x0000000000000000000000000000000000000002';
const escrow = '0x0000000000000000000000000000000000000003';
const hash = `0x${'12'.repeat(32)}`;
const config = { enabled: true, chainId: 43113, token, escrow };
const match = { matchId: `0x${'34'.repeat(32)}`, token, escrow, stake: '100' };

function fixture({ receiptError = false, chainId = 43113n, deposited = false, claimed = false, state = 1,
  storage = new Map(), receiptStatus = 1, fetch: fetchMock = async () => {}, signMessage = async () => 'signature' } = {}) {
  let deposits = 0;
  let claims = 0;
  class Provider {
    async getNetwork() { return { chainId }; }
    async getSigner() { return { getAddress: async () => address, signMessage }; }
    async getTransactionReceipt() {
      if (receiptError) throw new Error('RPC unavailable');
      return { status: receiptStatus };
    }
  }
  class Contract {
    async balanceOf() { return 100n; }
    async allowance() { return 100n; }
    async depositedFor() { return deposited ? 100n : 0n; }
    async getMatch() {
      return { state, stake: 100n, recipients: [address], deposited: deposited ? 1 : 0, ready: 0,
        claimed: claimed ? 1 : 0, inspectionEnds: 0 };
    }
    async joinAndDeposit() { deposits++; return { hash }; }
    async claimPayout() { claims++; return { hash }; }
  }
  const listeners = new Map();
  const window = {
    ethers: { ...ethers, BrowserProvider: Provider, Contract },
    ethereum: { request: async () => [address], on: (name, callback) => listeners.set(name, callback) },
    localStorage: { getItem: (key) => storage.get(key), setItem: (key, value) => storage.set(key, value), removeItem: (key) => storage.delete(key) },
    dispatchEvent: () => {},
    setTimeout,
  };
  vm.runInNewContext(source, { window, fetch: fetchMock, CustomEvent: class {} });
  return { api: window.RageFridgeWallet, invalidate: () => listeners.get('accountsChanged')(), counts: () => ({ deposits, claims }) };
}

test('wallet retains the transaction hash when receipt RPC fails after a deposit', async () => {
  const { api, counts } = fixture({ receiptError: true });
  const result = await api.transact('deposit', config, match, address);
  assert.equal(result.pending, true);
  assert.equal(result.hash, hash);
  assert.match(result.reason, /lookup failed/);
  assert.equal(counts().deposits, 1);
});

test('wallet refuses wrong network and cross-contract room snapshots without sending transactions', async () => {
  const { api, counts } = fixture({ chainId: 1n });
  await assert.rejects(api.transact('deposit', config, match, address), /Fuji/);
  assert.equal(counts().deposits, 0);
  assert.throws(() => api.safeConfig(config, { ...match, escrow: address }), /do not match/);
});

test('history claims use terminal contract state and reject already-claimed matches', async () => {
  const available = fixture({ state: 6, deposited: true });
  const result = await available.api.transact('claim', config, match, address);
  assert.equal(result.pending, false);
  assert.equal(available.counts().claims, 1);
  const claimed = fixture({ state: 6, deposited: true, claimed: true });
  await assert.rejects(claimed.api.transact('claim', config, match, address), /no unclaimed/);
  assert.equal(claimed.counts().claims, 0);
  const funding = fixture();
  await assert.rejects(funding.api.transact('claim', config, match, address), /no unclaimed/);
});

test('submitted transaction guard survives reload and clears only after a terminal receipt', async () => {
  const storage = new Map();
  const first = fixture({ storage, receiptError: true });
  await first.api.transact('deposit', config, match, address);
  assert.equal(first.api.pendingTransaction(config).hash, hash);
  const reloaded = fixture({ storage, receiptError: true });
  assert.equal(reloaded.api.pendingTransaction(config).hash, hash);
  await assert.rejects(reloaded.api.transact('deposit', config, match, address), /RPC unavailable/);
  assert.equal(reloaded.counts().deposits, 0);
  assert.equal(reloaded.api.pendingTransaction(config).hash, hash);
  const confirmed = fixture({ storage });
  assert.equal((await confirmed.api.receipt(config, hash)).success, true);
  assert.equal(confirmed.api.pendingTransaction(config), null);
  assert.equal(storage.size, 0);
});

test('wallet clears a reverted transaction and prevents concurrent signature prompts', async () => {
  const reverted = fixture({ receiptStatus: 0 });
  await assert.rejects(reverted.api.transact('deposit', config, match, address), /reverted/);
  assert.equal(reverted.api.pendingTransaction(config), null);
  const concurrent = fixture();
  const first = concurrent.api.transact('deposit', config, match, address);
  await assert.rejects(concurrent.api.transact('deposit', config, match, address), /already being processed/);
  await first;
  assert.equal(concurrent.counts().deposits, 1);
});

test('authentication rejects account changes while the server session response is pending', async () => {
  let release;
  let requested;
  const sessionRequested = new Promise((resolve) => { requested = resolve; });
  const client = fixture({ fetch: async (path) => {
    if (path.endsWith('/challenge')) return { ok: true, json: async () => ({ message: 'challenge', challengeId: 'id' }) };
    requested();
    await new Promise((resolve) => { release = resolve; });
    return { ok: true, json: async () => ({ token: 'token', address }) };
  } });
  const authentication = client.api.authenticate(config);
  await sessionRequested;
  client.invalidate();
  release();
  await assert.rejects(authentication, /identity changed/);
});
