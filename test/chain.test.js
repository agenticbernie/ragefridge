import test from 'node:test';
import assert from 'node:assert/strict';
import * as ethers from 'ethers';
import { Game } from '../server/game.js';
import {
  calculatePayouts,
  canonicalFinancialEvents,
  createChainCoordinator,
  DEFAULT_ESCROW_ADDRESS,
  DEFAULT_TOKEN_ADDRESS,
  makeRulesHash,
  orderedEventLogRoot,
} from '../server/chain.js';

test('cold and sabotage payouts conserve the escrow pool with deterministic dust', () => {
  const coldPlayers = [
    { role: 'chef', alive: true, weight: 125 },
    { role: 'chef', alive: true, weight: 125 },
    { role: 'saboteur', alive: true, weight: 0 },
    { role: 'stoic', alive: true, weight: 200 },
  ];
  const cold = calculatePayouts('cold', 100n, coldPlayers);
  assert.deepEqual(cold, [112n, 111n, 0n, 177n]);
  assert.equal(cold.reduce((sum, amount) => sum + amount, 0n), 400n);

  const sabotage = calculatePayouts('sabotage', 100n, coldPlayers.map((player) => ({
    ...player, weight: player.role === 'saboteur' ? 100 : 0,
  })));
  assert.deepEqual(sabotage, [0n, 0n, 400n, 0n]);
  assert.deepEqual(calculatePayouts('draw', 100n, coldPlayers), [100n, 100n, 100n, 100n]);
  assert.deepEqual(calculatePayouts('void', 100n, coldPlayers), [100n, 100n, 100n, 100n]);
});

test('payout calculator rejects invalid pools and a winner without an eligible recipient', () => {
  const noWinners = Array.from({ length: 4 }, () => ({ role: 'chef', alive: false, weight: 0 }));
  assert.throws(() => calculatePayouts('cold', 0n, noWinners), /Stake/);
  assert.throws(() => calculatePayouts('cold', 1n, noWinners), /eligible winner/);
  assert.throws(() => calculatePayouts('unknown', 1n, noWinners), /Unsupported/);
  assert.throws(() => calculatePayouts('cold', 1n, []), /four/);
});

test('financial event encoding preserves canonical sequence and omits unapproved text', () => {
  const game = {
    players: [{ id: 'a' }, { id: 'b' }],
    events: [{ id: 1, at: 12, type: 'roast', text: 'private line', actor: 'a', target: 'b', tier: 2, delta: -4 }],
  };
  const [event] = canonicalFinancialEvents(game);
  assert.deepEqual(JSON.parse(event), { id: 1, at: 12, type: 'roast', actor: 0, target: 1, tier: 2, delta: -4 });
  assert.doesNotMatch(event, /private line/);
  assert.throws(() => canonicalFinancialEvents({ ...game, events: [{ ...game.events[0], id: 2 }] }), /contiguous/);
  assert.throws(() => canonicalFinancialEvents({ ...game, events: [{ ...game.events[0], target: 'unknown' }] }), /outside the roster/);
});

test('rules hash and ordered event root are stable but bind distinct event logs', () => {
  const matchId = ethers.keccak256(ethers.toUtf8Bytes('room'));
  const events = ['{"id":1,"type":"start"}', '{"id":2,"type":"result"}'];
  const first = orderedEventLogRoot(ethers, matchId, events);
  assert.equal(first, orderedEventLogRoot(ethers, matchId, events));
  assert.notEqual(first, orderedEventLogRoot(ethers, ethers.ZeroHash, events));
  assert.notEqual(first, orderedEventLogRoot(ethers, matchId, [...events].reverse()));
  assert.equal(makeRulesHash(ethers, { b: 2, a: 1 }), makeRulesHash(ethers, { a: 1, b: 2 }));
});

test('disabled chain coordinator stays read-only and does not accept wallet allowlisting', async () => {
  const coordinator = await createChainCoordinator({ env: { CHAIN_ENABLED: 'false' } });
  assert.deepEqual(coordinator.publicConfig(), { enabled: false, chainId: 43113, token: '0x5c6c67f33ad8cf10cc09d59425d2c9bba3b8fe35', escrow: '0xfb91ddbe90fbf0250e72d7ccb11f0e1d8669ed4f', stake: '10000000000000000000', inviteRequired: false });
  assert.equal(coordinator.isAllowedPlayer('0x0000000000000000000000000000000000000001'), false);
  await coordinator.close();
});

async function coordinatorFixture({ failCreate = false } = {}) {
  const creator = ethers.Wallet.createRandom();
  const signers = [ethers.Wallet.createRandom(), ethers.Wallet.createRandom(), ethers.Wallet.createRandom()];
  const players = Array.from({ length: 4 }, (_, index) => ({
    id: `seat-${index}`,
    wallet: ethers.getAddress(`0x${(index + 1).toString(16).padStart(40, '0')}`),
  }));
  const allowedPlayer = players[0].wallet;
  const matchStore = new Map();
  const store = {
    get: (id) => matchStore.get(id.toLowerCase()) ?? null,
    all: () => [...matchStore.values()],
    put: async (record) => { matchStore.set(record.matchId.toLowerCase(), structuredClone(record)); },
  };
  let blockTime = 100;
  const provider = {
    getNetwork: async () => ({ chainId: 43113n }),
    getCode: async () => '0x6000',
    getBalance: async () => 1n,
    getBlock: async () => ({ timestamp: blockTime }),
    destroy: async () => {},
  };
  const token = {
    name: async () => 'RageFridge Test Credit',
    symbol: async () => 'RFC',
    decimals: async () => 18,
  };
  let match = null;
  let createCalls = 0;
  let timeoutCalls = 0;
  let lockCalls = 0;
  let startCalls = 0;
  let resultCalls = 0;
  let finalizeCalls = 0;
  let rpcError = false;
  const startDomain = { name: 'RageFridgeEscrow', version: '1', chainId: 43113, verifyingContract: DEFAULT_ESCROW_ADDRESS };
  const startTypes = { Start: [
    { name: 'matchId', type: 'bytes32' }, { name: 'rulesHash', type: 'bytes32' },
    { name: 'rosterHash', type: 'bytes32' }, { name: 'roleCommitment', type: 'bytes32' },
    { name: 'lockTimestamp', type: 'uint64' }, { name: 'expiry', type: 'uint64' },
  ] };
  const startValue = (matchId, expiry) => ({ matchId, rulesHash: match.rulesHash, rosterHash: match.rosterHash,
    roleCommitment: match.roleCommitment, lockTimestamp: match.lockAt, expiry });
  const resultTypes = { Result: [
    { name: 'matchId', type: 'bytes32' }, { name: 'rulesHash', type: 'bytes32' },
    { name: 'rosterHash', type: 'bytes32' }, { name: 'startTimestamp', type: 'uint64' },
    { name: 'outcome', type: 'uint8' }, { name: 'roleSeed', type: 'bytes32' },
    { name: 'merkleRoot', type: 'bytes32' }, { name: 'payouts', type: 'uint256[4]' },
    { name: 'fee', type: 'uint256' }, { name: 'expiry', type: 'uint64' },
  ] };
  const escrowReader = {
    token: async () => ethers.getAddress(DEFAULT_TOKEN_ADDRESS),
    creator: async () => creator.address,
    signers: async (index) => signers[index].address,
    getMatch: async () => { if (rpcError) throw new Error('RPC unavailable'); return match ?? { state: 0 }; },
    startDigest: async (matchId, expiry) => ethers.TypedDataEncoder.hash(startDomain, startTypes, startValue(matchId, expiry)),
    rolesFor: async () => [0, 0, 1, 2],
    resultDigest: async (result) => ethers.TypedDataEncoder.hash(startDomain, resultTypes, result),
  };
  const escrow = {
    submitResult: async (result, signatures) => {
      resultCalls++;
      assert.deepEqual(signatures.map((signature) => ethers.verifyTypedData(startDomain, resultTypes, result, signature)),
        signers.slice(0, 2).map((wallet) => wallet.address));
      assert.equal(result.payouts.reduce((sum, payout) => sum + payout, 0n), match.stake * 4n);
      assert.equal(result.fee, 0n);
      match.state = 4;
      match.inspectionEnds = BigInt(blockTime + 120);
      match.payouts = result.payouts;
      return { hash: `0x${'56'.repeat(32)}`, wait: async () => ({ status: 1 }) };
    },
    finalize: async () => {
      finalizeCalls++;
      match.state = 5;
      return { hash: `0x${'78'.repeat(32)}`, wait: async () => ({ status: 1 }) };
    },
    lockMatch: async () => {
      lockCalls++;
      match.state = 2;
      match.lockAt = BigInt(blockTime);
      return { wait: async () => ({ status: 1 }) };
    },
    startMatch: async (matchId, expiry, signatures) => {
      startCalls++;
      const recovered = signatures.map((signature) => ethers.verifyTypedData(startDomain, startTypes, startValue(matchId, expiry), signature));
      assert.deepEqual(recovered, signers.slice(0, 2).map((wallet) => wallet.address));
      match.state = 3;
      match.startAt = BigInt(blockTime);
      return { wait: async () => ({ status: 1 }) };
    },
    timeout: async () => {
      timeoutCalls++;
      match.state = 6;
      return { hash: `0x${'34'.repeat(32)}`, wait: async () => ({ status: 1 }) };
    },
    createMatch: async (matchId, recipients, stake, rulesHash, roleCommitment) => {
      createCalls += 1;
      if (failCreate) { failCreate = false; throw new Error('RPC unavailable before broadcast'); }
      match = {
        state: 1, createdAt: 100n, lockAt: 0n, startAt: 0n, inspectionEnds: 0n, stake,
        rulesHash, rosterHash: ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(['address[4]'], [recipients])),
        roleCommitment, recipients, deposited: 0, ready: 0, claimed: 0, outcome: 0,
        resultFingerprint: ethers.ZeroHash, payouts: [0n, 0n, 0n, 0n],
      };
      return { hash: `0x${'12'.repeat(32)}`, wait: async () => ({ status: 1 }) };
    },
  };
  const options = {
    env: {
      CHAIN_ENABLED: 'true',
      FUJI_RPC_URL: 'https://fuji.example.invalid',
      CHAIN_CREATOR_KEY: creator.privateKey,
      CHAIN_SIGNER_KEYS: signers.map((wallet) => wallet.privateKey).join(','),
      CHAIN_ALLOWED_PLAYERS: allowedPlayer,
      CHAIN_STATE_DIR: '/unused-with-injected-store',
    },
    dependencies: { ethers, provider, token, escrowReader, escrow, creatorWallet: creator,
      signerWallets: signers, nonceManager: {}, store, skipBalanceCheck: true },
  };
  const coordinator = await createChainCoordinator(options);
  return { coordinator, players, allowedPlayer, matchStore, escrowReader,
    get match() { return match; },
    get counts() { return { createCalls, timeoutCalls, lockCalls, startCalls, resultCalls, finalizeCalls }; },
    setTime: (time) => { blockTime = time; }, setRpcError: (value) => { rpcError = value; },
    restart: () => createChainCoordinator(options),
  };
}

test('Fuji coordinator verifies deployment pins and creates one persistent roster-bound match', async () => {
  const fixture = await coordinatorFixture();
  const { coordinator, players, allowedPlayer, matchStore } = fixture;
  try {
    assert.equal(coordinator.publicConfig().inviteRequired, true);
    assert.equal(coordinator.isAllowedPlayer(allowedPlayer), true);
    assert.equal(coordinator.isAllowedPlayer(players[1].wallet), false);
    const game = { code: 'ABC123', phase: 'lobby', players };
    const prepared = await coordinator.prepare(game);
    assert.equal(prepared.state, 'FUNDING');
    assert.equal(prepared.token, DEFAULT_TOKEN_ADDRESS);
    assert.equal(prepared.escrow, DEFAULT_ESCROW_ADDRESS);
    assert.deepEqual(prepared.recipients, players.map((player) => player.wallet.toLowerCase()));
    assert.equal(fixture.counts.createCalls, 1);
    assert.equal(matchStore.size, 1);
    await coordinator.prepare(game);
    assert.equal(fixture.counts.createCalls, 1);
    const { match } = fixture;
    match.deposited = 3;
    match.ready = 1;
    await coordinator.tick();
    assert.equal(game.chain.depositedCount, 2);
    assert.equal(game.chain.readyCount, 1);
    match.deposited = 15;
    match.ready = 15;
    const [roles, repeatedRoles] = await Promise.all([coordinator.start(game), coordinator.start(game)]);
    assert.deepEqual(roles, ['chef', 'chef', 'saboteur', 'stoic']);
    assert.deepEqual(repeatedRoles, roles);
    assert.equal(fixture.counts.lockCalls, 1);
    assert.equal(fixture.counts.startCalls, 1);
    assert.equal(game.chain.state, 'ACTIVE');
    fixture.setTime(520);
    // A corrupted roster/stake must never authorize timeout transactions.
    const originalStake = match.stake;
    match.stake += 1n;
    await coordinator.tick();
    assert.equal(fixture.counts.timeoutCalls, 0);
    match.stake = originalStake;
    await coordinator.tick();
    assert.equal(fixture.counts.timeoutCalls, 1);
    assert.equal(game.chain.state, 'REFUNDABLE');
    const history = coordinator.listMatches(players[0].wallet);
    assert.equal(history.matches.length, 1);
    assert.equal(history.matches[0].matchId, prepared.matchId);
    assert.equal(history.matches[0].state, 'REFUNDABLE');
    assert.equal(history.nextOffset, null);
    assert.doesNotMatch(JSON.stringify(history), /roleSeed|audit|canonicalEvents/);
    assert.deepEqual(coordinator.listMatches(ethers.Wallet.createRandom().address), { matches: [], nextOffset: null });
    assert.throws(() => coordinator.listMatches(players[0].wallet, -1), /offset/);
    await coordinator.tick();
    assert.equal(fixture.counts.timeoutCalls, 1);
  } finally {
    await coordinator.close();
  }
});

test('coordinator retries failed creation with the same persisted match ID', async (t) => {
  const fixture = await coordinatorFixture({ failCreate: true });
  t.after(() => fixture.coordinator.close());
  const game = { code: 'RETRY1', phase: 'lobby', players: fixture.players };
  await assert.rejects(fixture.coordinator.prepare(game), /RPC unavailable/);
  const matchId = game.chain.matchId;
  assert.equal(fixture.matchStore.size, 1);
  await fixture.coordinator.tick();
  assert.equal(game.chain.matchId, matchId);
  assert.equal(game.chain.state, 'FUNDING');
  assert.equal(fixture.counts.createCalls, 2);
});

test('verified result uses two signatures, survives restart, and finalizes once after inspection', async (t) => {
  const fixture = await coordinatorFixture();
  t.after(() => fixture.coordinator.close());
  const game = new Game('RESULT');
  game.paid = true;
  for (const player of fixture.players) game.addPlayer(player.id, player.id).wallet = player.wallet;
  await fixture.coordinator.prepare(game);
  fixture.match.deposited = 15;
  fixture.match.ready = 15;
  const roles = await fixture.coordinator.start(game);
  assert.equal(game.start(game.hostId, roles), null);
  game.audit.inputs.push({ type: 'stop' });
  game.finish('void', 'safetyStop');
  // No operator signature is permitted for a game that fails deterministic replay.
  game.temperature++;
  await assert.rejects(fixture.coordinator.complete(game), /Replay mismatch/);
  assert.equal(fixture.counts.resultCalls, 0);
  game.temperature--;
  const [first, repeated] = await Promise.all([fixture.coordinator.complete(game), fixture.coordinator.complete(game)]);
  assert.equal(first.state, 'RESULT_PENDING');
  assert.equal(repeated.state, 'RESULT_PENDING');
  assert.equal(fixture.counts.resultCalls, 1);
  assert.equal(fixture.counts.finalizeCalls, 0);
  const restarted = await fixture.restart();
  t.after(() => restarted.close());
  assert.equal(restarted.listMatches(fixture.players[0].wallet).matches[0].state, 'RESULT_PENDING');
  fixture.setRpcError(true);
  fixture.setTime(220);
  await restarted.tick();
  assert.equal(fixture.counts.finalizeCalls, 0);
  assert.equal(restarted.listMatches(fixture.players[0].wallet).matches[0].state, 'RESULT_PENDING');
  fixture.setRpcError(false);
  await restarted.tick();
  assert.equal(fixture.counts.finalizeCalls, 1);
  assert.equal(restarted.listMatches(fixture.players[0].wallet).matches[0].state, 'SETTLED');
  await restarted.tick();
  assert.equal(fixture.counts.finalizeCalls, 1);
  assert.equal(fixture.counts.resultCalls, 1);
});

test('startup recovery refuses mismatched persisted stake or unavailable RPC', async (t) => {
  const fixture = await coordinatorFixture();
  t.after(() => fixture.coordinator.close());
  const game = { code: 'BROKEN', phase: 'lobby', players: fixture.players };
  await fixture.coordinator.prepare(game);
  fixture.match.stake++;
  await assert.rejects(fixture.restart(), /startup recovery failed/);
  fixture.match.stake--;
  fixture.setRpcError(true);
  await assert.rejects(fixture.restart(), /startup recovery failed/);
});

test('wallet history pages newest first and never returns another wallet or private evidence', async (t) => {
  const fixture = await coordinatorFixture();
  t.after(() => fixture.coordinator.close());
  const game = { code: 'PAGING', phase: 'lobby', players: fixture.players };
  await fixture.coordinator.prepare(game);
  const template = [...fixture.matchStore.values()][0];
  fixture.matchStore.clear();
  for (let index = 0; index < 101; index++) {
    const matchId = `0x${index.toString(16).padStart(64, '0')}`;
    fixture.matchStore.set(matchId, { ...template, matchId, audit: { private: true }, canonicalEvents: ['private'] });
  }
  const pages = [0, 50, 100].map((offset) => fixture.coordinator.listMatches(fixture.players[0].wallet, offset));
  assert.deepEqual(pages.map((page) => page.matches.length), [50, 50, 1]);
  assert.deepEqual(pages.map((page) => page.nextOffset), [50, 100, null]);
  const ids = pages.flatMap((page) => page.matches.map((match) => match.matchId));
  assert.equal(new Set(ids).size, 101);
  assert.equal(ids[0], `0x${(100).toString(16).padStart(64, '0')}`);
  assert.doesNotMatch(JSON.stringify(pages), /roleSeed|audit|canonicalEvents|private/);
  assert.equal(fixture.coordinator.listMatches(ethers.Wallet.createRandom().address).matches.length, 0);
});
