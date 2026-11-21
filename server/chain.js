import { randomBytes } from 'node:crypto';
import { rules } from './game.js';
import { JsonChainStore } from './chain-store.js';

export const FUJI_CHAIN_ID = 43113;
export const DEFAULT_TOKEN_ADDRESS = '0x5c6c67f33ad8cf10cc09d59425d2c9bba3b8fe35';
export const DEFAULT_ESCROW_ADDRESS = '0xfb91ddbe90fbf0250e72d7ccb11f0e1d8669ed4f';
export const DEFAULT_STAKE = '10000000000000000000';
const STORE_TERMINAL = new Set(['settled', 'refundable']);
const STATE = Object.freeze({ none: 0, funding: 1, locked: 2, active: 3, resultPending: 4, settled: 5, refundable: 6 });
const RESULT_WINDOW = 420n;
const START_WINDOW = 60n;
const FUNDING_WINDOW = 120n;
const INSPECTION_WINDOW = 120n;
const TERMINAL_TIMEOUT = 600n;
const EVENT_DOMAIN_TEXT = 'RageFridge.EventLog.v1';
const TX_BUDGET_PER_MINUTE = 30;
const GAS_LIMITS = Object.freeze({
  createMatch: 650_000n, lockMatch: 180_000n, startMatch: 300_000n,
  submitResult: 900_000n, finalize: 160_000n, timeout: 160_000n,
});
const TOKEN_ABI = [
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
];
const ESCROW_ABI = [
  'function token() view returns (address)',
  'function creator() view returns (address)',
  'function signers(uint256) view returns (address)',
  'function createMatch(bytes32 matchId,address[4] recipients,uint256 stake,bytes32 rulesHash,bytes32 roleCommitment)',
  'function getMatch(bytes32 matchId) view returns (tuple(uint8 state,uint64 createdAt,uint64 lockAt,uint64 startAt,uint64 inspectionEnds,uint256 stake,bytes32 rulesHash,bytes32 rosterHash,bytes32 roleCommitment,address[4] recipients,uint8 deposited,uint8 ready,uint8 claimed,uint8 outcome,bytes32 resultFingerprint,uint256[4] payouts))',
  'function rolesFor(bytes32 matchId,bytes32 roleSeed) view returns (uint8[4])',
  'function lockMatch(bytes32 matchId)',
  'function startDigest(bytes32 matchId,uint64 expiry) view returns (bytes32)',
  'function startMatch(bytes32 matchId,uint64 expiry,bytes[2] signatures)',
  'function resultDigest(tuple(bytes32 matchId,bytes32 rulesHash,bytes32 rosterHash,uint64 startTimestamp,uint8 outcome,bytes32 roleSeed,bytes32 merkleRoot,uint256[4] payouts,uint256 fee,uint64 expiry) result) view returns (bytes32)',
  'function submitResult(tuple(bytes32 matchId,bytes32 rulesHash,bytes32 rosterHash,uint64 startTimestamp,uint8 outcome,bytes32 roleSeed,bytes32 merkleRoot,uint256[4] payouts,uint256 fee,uint64 expiry) result,bytes[2] signatures)',
  'function finalize(bytes32 matchId)',
  'function timeout(bytes32 matchId)',
];

const field = (tuple, name, index) => tuple?.[name] ?? tuple?.[index];
const uint = (value) => BigInt(value ?? 0);
const canonicalAddress = (ethers, value) => ethers.getAddress(String(value).toLowerCase());
const countMask = (mask) => {
  let value = Number(mask) || 0;
  let count = 0;
  while (value) {
    count += value & 1;
    value >>>= 1;
  }
  return count;
};

function stableValue(value) {
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().filter((key) => value[key] !== undefined)
      .map((key) => [key, stableValue(value[key])]));
  }
  if (typeof value === 'number' && !Number.isFinite(value)) throw new TypeError('Non-finite values cannot be canonicalized.');
  return value;
}

export function canonicalJson(value) {
  return JSON.stringify(stableValue(value));
}

export function makeRulesHash(ethers, rulesValue = rules) {
  return ethers.keccak256(ethers.toUtf8Bytes(canonicalJson(rulesValue)));
}

export function calculatePayouts(outcome, stake, resultPlayers) {
  const amount = BigInt(stake);
  if (amount <= 0n || amount > ((1n << 256n) - 1n) / 4n) throw new RangeError('Stake is outside the escrow range.');
  if (!Array.isArray(resultPlayers) || resultPlayers.length !== 4) throw new TypeError('Exactly four replayed seats are required.');
  if (outcome === 'draw' || outcome === 'void') return resultPlayers.map(() => amount);

  const win = outcome === 'cold' ? (player) => player.role !== 'saboteur' :
    outcome === 'sabotage' ? (player) => player.role === 'saboteur' : null;
  if (!win) throw new Error(`Unsupported game outcome: ${outcome}`);
  const weights = resultPlayers.map((player) => win(player) && player.alive ? BigInt(player.weight) : 0n);
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0n);
  if (totalWeight <= 0n) throw new Error('A winning game outcome must have at least one eligible winner.');
  const pool = amount * 4n;
  const payouts = weights.map((weight) => (pool * weight) / totalWeight);
  let remainder = pool - payouts.reduce((sum, payout) => sum + payout, 0n);
  for (let seat = 0; remainder > 0n; seat = (seat + 1) % 4) {
    if (weights[seat] > 0n) {
      payouts[seat] += 1n;
      remainder -= 1n;
    }
  }
  if (payouts.reduce((sum, payout) => sum + payout, 0n) !== pool) throw new Error('Payout allocation failed conservation.');
  return payouts;
}

export function canonicalFinancialEvents(game) {
  if (!Array.isArray(game?.events) || !Array.isArray(game?.players)) throw new Error('Game event log is unavailable.');
  const seatById = new Map(game.players.map((player, index) => [player.id, index]));
  const allowed = ['actor', 'target', 'reason', 'tier', 'delta', 'repeat', 'deflected'];
  return game.events.map((event, index) => {
    if (!event || event.id !== index + 1 || !Number.isSafeInteger(event.at) || typeof event.type !== 'string') {
      throw new Error('Game event log is not a contiguous canonical sequence.');
    }
    const canonical = { id: event.id, at: event.at, type: event.type };
    for (const key of allowed) {
      if (event[key] === undefined) continue;
      if (key === 'actor' || key === 'target') {
        if (!seatById.has(event[key])) throw new Error('Game event refers to a seat outside the roster.');
        canonical[key] = seatById.get(event[key]);
      } else {
        canonical[key] = event[key];
      }
    }
    return canonicalJson(canonical);
  });
}

export function orderedEventLogRoot(ethers, matchId, canonicalEvents) {
  if (!Array.isArray(canonicalEvents)) throw new TypeError('Canonical events must be an array.');
  const coder = ethers.AbiCoder.defaultAbiCoder();
  const domain = ethers.keccak256(ethers.toUtf8Bytes(EVENT_DOMAIN_TEXT));
  const leafHashes = canonicalEvents.map((event, index) => ethers.keccak256(coder.encode(
    ['bytes32', 'uint8', 'bytes32', 'uint256', 'bytes32'],
    [domain, 0, matchId, BigInt(index), ethers.keccak256(ethers.toUtf8Bytes(event))],
  )));
  let top = ethers.ZeroHash;
  if (leafHashes.length) {
    let level = leafHashes;
    while (level.length > 1) {
      const next = [];
      for (let index = 0; index < level.length; index += 2) {
        next.push(ethers.keccak256(coder.encode(
          ['bytes32', 'uint8', 'bytes32', 'bytes32'],
          [domain, 1, level[index], level[index + 1] ?? level[index]],
        )));
      }
      level = next;
    }
    [top] = level;
  }
  return ethers.keccak256(coder.encode(
    ['bytes32', 'uint8', 'bytes32', 'uint256', 'bytes32'],
    [domain, 2, matchId, BigInt(canonicalEvents.length), top],
  ));
}

function publicMatch(record) {
  return {
    matchId: record.matchId,
    state: record.status.toUpperCase().replaceAll('-', '_'),
    stake: record.stake,
    depositedCount: record.depositedCount ?? 0,
    readyCount: record.readyCount ?? 0,
    recipients: [...record.recipients],
    token: record.token,
    escrow: record.escrow,
    inspectionEnds: record.inspectionEnds,
    ...(record.txHash ? { txHash: record.txHash } : {}),
    ...(record.resultTxHash ? { resultTxHash: record.resultTxHash } : {}),
  };
}

function mapContractState(state) {
  return ['none', 'funding', 'locked', 'active', 'result-pending', 'settled', 'refundable'][Number(state)] ?? 'unknown';
}

function checkRoster(ethers, game) {
  if (!Array.isArray(game?.players) || game.players.length !== 4) throw new Error('A chain match needs exactly four human seats.');
  if (game.players.some((player) => player.bot || !player.wallet)) throw new Error('Every chain seat must be bound to a wallet; bot seats are not eligible.');
  const recipients = game.players.map((player) => canonicalAddress(ethers, player.wallet));
  if (new Set(recipients.map((address) => address.toLowerCase())).size !== 4) throw new Error('Each chain seat needs a distinct wallet.');
  return recipients;
}

function assertSameRoster(record, game, ethers) {
  const recipients = checkRoster(ethers, game);
  if (recipients.some((recipient, index) => recipient.toLowerCase() !== record.recipients[index].toLowerCase())) {
    throw new Error('The wallet roster changed after the escrow match was prepared.');
  }
}

function rolesFromEnum(values) {
  const names = ['chef', 'saboteur', 'stoic'];
  const roles = Array.from(values, (value) => names[Number(value)]);
  if (roles.length !== 4 || roles.some((role) => !role)) throw new Error('Escrow returned an invalid role permutation.');
  return roles;
}

async function maybeImportReplay(injected) {
  if (injected) return injected;
  const replay = await import('./replay.js');
  return replay.verifyReplay;
}

/** Build an optional server-operated Fuji escrow coordinator. Disabled mode never imports ethers. */
export async function createChainCoordinator({ env = process.env, onUpdate = () => {}, dependencies = {} } = {}) {
  const enabled = env.CHAIN_ENABLED === 'true';
  const publicConfig = Object.freeze({
    enabled,
    chainId: FUJI_CHAIN_ID,
    token: DEFAULT_TOKEN_ADDRESS,
    escrow: DEFAULT_ESCROW_ADDRESS,
    stake: String(env.CHAIN_STAKE ?? DEFAULT_STAKE),
    inviteRequired: enabled && Boolean(String(env.CHAIN_ALLOWED_PLAYERS ?? '').trim()),
  });
  if (!enabled) {
    return Object.freeze({
      publicConfig: () => publicConfig,
      isAllowedPlayer: () => false,
      listMatches: () => ({ matches: [], nextOffset: null }),
      prepare: async () => null,
      start: async () => null,
      complete: async () => null,
      tick: async () => {},
      close: async () => {},
    });
  }

  const missing = ['FUJI_RPC_URL', 'CHAIN_CREATOR_KEY', 'CHAIN_SIGNER_KEYS', 'CHAIN_STATE_DIR']
    .filter((key) => !String(env[key] ?? '').trim());
  if (missing.length) throw new Error(`Fuji chain mode requires: ${missing.join(', ')}.`);

  const ethers = dependencies.ethers ?? await import('ethers');
  const tokenAddress = canonicalAddress(ethers, env.CHAIN_TOKEN_ADDRESS ?? DEFAULT_TOKEN_ADDRESS);
  const escrowAddress = canonicalAddress(ethers, env.CHAIN_ESCROW_ADDRESS ?? DEFAULT_ESCROW_ADDRESS);
  const stake = String(env.CHAIN_STAKE ?? ethers.parseEther('10').toString());
  if (!/^\d+$/.test(stake) || BigInt(stake) <= 0n || BigInt(stake) > ethers.MaxUint256 / 4n) {
    throw new Error('CHAIN_STAKE must be a positive integer amount in token base units.');
  }
  const privateKeys = String(env.CHAIN_SIGNER_KEYS).split(',').map((key) => key.trim()).filter(Boolean);
  if (privateKeys.length < 2) throw new Error('CHAIN_SIGNER_KEYS must contain at least two quorum keys.');
  // Detect the RPC network rather than trusting a statically asserted chain ID.
  const provider = dependencies.provider ?? new ethers.JsonRpcProvider(env.FUJI_RPC_URL);
  let network;
  try { network = await provider.getNetwork(); } catch {
    throw new Error('Fuji RPC health check failed; verify the configured endpoint and retry.');
  }
  if (Number(network.chainId) !== FUJI_CHAIN_ID) throw new Error(`Configured RPC must be Avalanche Fuji (${FUJI_CHAIN_ID}).`);

  let creatorWallet;
  let signerWallets;
  try {
    creatorWallet = dependencies.creatorWallet ?? new ethers.Wallet(env.CHAIN_CREATOR_KEY, provider);
    signerWallets = dependencies.signerWallets ?? privateKeys.map((key) => new ethers.Wallet(key));
  } catch {
    throw new Error('Fuji operator key configuration is invalid; check server secrets.');
  }
  const creatorAddress = canonicalAddress(ethers, creatorWallet.address);
  const creator = dependencies.nonceManager ?? new ethers.NonceManager(creatorWallet);
  const uniqueSignerAddresses = signerWallets.map((wallet) => canonicalAddress(ethers, wallet.address).toLowerCase());
  if (uniqueSignerAddresses.length < 2 || new Set(uniqueSignerAddresses).size !== uniqueSignerAddresses.length) {
    throw new Error('Configured quorum signer keys must have unique addresses.');
  }
  let allowedPlayers;
  try {
    allowedPlayers = new Set(String(env.CHAIN_ALLOWED_PLAYERS ?? '').split(',').map((address) => address.trim())
      .filter(Boolean).map((address) => canonicalAddress(ethers, address).toLowerCase()));
  } catch {
    throw new Error('CHAIN_ALLOWED_PLAYERS contains an invalid wallet address.');
  }

  const token = dependencies.token ?? new ethers.Contract(tokenAddress, TOKEN_ABI, provider);
  const escrowReader = dependencies.escrowReader ?? new ethers.Contract(escrowAddress, ESCROW_ABI, provider);
  const escrow = dependencies.escrow ?? new ethers.Contract(escrowAddress, ESCROW_ABI, creator);
  let tokenCode;
  let escrowCode;
  try {
    [tokenCode, escrowCode] = await Promise.all([provider.getCode(tokenAddress), provider.getCode(escrowAddress)]);
  } catch {
    throw new Error('Could not verify Fuji token and escrow bytecode; check RPC availability.');
  }
  if (tokenCode === '0x' || escrowCode === '0x') throw new Error('Configured Fuji token and escrow must both have deployed code.');
  let tokenName;
  let tokenSymbol;
  let decimals;
  let configuredToken;
  let configuredCreator;
  let onchainSigners;
  try {
    [tokenName, tokenSymbol, decimals, configuredToken, configuredCreator, onchainSigners] = await Promise.all([
      token.name(), token.symbol(), token.decimals(), escrowReader.token(), escrowReader.creator(),
      Promise.all([0, 1, 2].map((index) => escrowReader.signers(index))),
    ]);
  } catch {
    throw new Error('Could not verify Fuji token metadata and escrow configuration.');
  }
  if (tokenName !== 'RageFridge Test Credit' || tokenSymbol !== 'RFC' || Number(decimals) !== 18) {
    throw new Error('Configured token metadata does not match RageFridge Test Credit.');
  }
  if (canonicalAddress(ethers, configuredToken).toLowerCase() !== tokenAddress.toLowerCase()) {
    throw new Error('Escrow token address does not match CHAIN_TOKEN_ADDRESS.');
  }
  if (canonicalAddress(ethers, configuredCreator).toLowerCase() !== creatorAddress.toLowerCase()) {
    throw new Error('CHAIN_CREATOR_KEY does not match the escrow creator.');
  }
  const signerSet = new Set(onchainSigners.map((address) => canonicalAddress(ethers, address).toLowerCase()));
  if (signerSet.size !== 3 || uniqueSignerAddresses.some((address) => !signerSet.has(address))) {
    throw new Error('Every configured quorum key must be a distinct signer in the escrow signer set.');
  }
  if (!dependencies.skipBalanceCheck) {
    const balance = await provider.getBalance(creatorAddress);
    if (balance <= 0n) throw new Error('The Fuji creator account needs test AVAX for escrow operations.');
  }

  const store = dependencies.store ?? await new JsonChainStore(env.CHAIN_STATE_DIR).init();
  if (dependencies.store && typeof store.init === 'function') await store.init();
  const recordLocks = new Map();
  const liveGames = new Map();
  const transactionTimes = [];
  const currentTime = dependencies.now ?? Date.now;
  let transactionQueue = Promise.resolve();
  let tickPromise = null;
  const serialTransaction = (operation) => {
    const pending = transactionQueue.then(operation, operation);
    transactionQueue = pending.catch(() => {});
    return pending;
  };

  const config = Object.freeze({ enabled: true, chainId: FUJI_CHAIN_ID,
    token: tokenAddress.toLowerCase(), escrow: escrowAddress.toLowerCase(), stake,
    inviteRequired: Boolean(String(env.CHAIN_ALLOWED_PLAYERS ?? '').trim()) });
  const attachGame = (record, game) => {
    if (game && typeof WeakRef === 'function') liveGames.set(record.matchId, new WeakRef(game));
  };
  const notify = (record, game) => {
    const currentGame = game ?? liveGames.get(record.matchId)?.deref();
    if (currentGame) currentGame.chain = publicMatch(record);
    else liveGames.delete(record.matchId);
    try { onUpdate(record.roomCode, publicMatch(record)); } catch { /* notification failure cannot alter settlement */ }
  };
  const commit = async (record, game) => {
    await store.put(record);
    attachGame(record, game);
    notify(record, game);
  };
  const getRecord = (game) => {
    const id = game?.chain?.matchId;
    const record = id ? store.get(id) : null;
    if (!record) throw new Error('This game has no prepared Fuji escrow match.');
    return record;
  };
  const readMatch = (id) => escrowReader.getMatch(id);
  const verifyOnchainRecord = (record, chainMatch, state) => {
    if (state === STATE.none) return;
    const chainRecipients = Array.from(field(chainMatch, 'recipients', 9), (address) => canonicalAddress(ethers, address));
    const expectedRosterHash = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(['address[4]'], [record.recipients]));
    if (uint(field(chainMatch, 'stake', 5)) !== BigInt(record.stake) ||
        String(field(chainMatch, 'rulesHash', 6)).toLowerCase() !== record.rulesHash.toLowerCase() ||
        String(field(chainMatch, 'roleCommitment', 8)).toLowerCase() !== record.roleCommitment.toLowerCase() ||
        String(field(chainMatch, 'rosterHash', 7)).toLowerCase() !== expectedRosterHash.toLowerCase() ||
        chainRecipients.length !== 4 || chainRecipients.some((address, index) =>
          address.toLowerCase() !== record.recipients[index].toLowerCase())) {
      throw new Error('Persisted match details do not match the deployed Fuji escrow state.');
    }
  };
  const recordMatchState = async (record, game) => {
    const chainMatch = await readMatch(record.matchId);
    const state = Number(field(chainMatch, 'state', 0));
    verifyOnchainRecord(record, chainMatch, state);
    record.status = mapContractState(state);
    record.lockAt = uint(field(chainMatch, 'lockAt', 2)).toString();
    record.startAt = uint(field(chainMatch, 'startAt', 3)).toString();
    record.createdAt = uint(field(chainMatch, 'createdAt', 1)).toString();
    record.inspectionEnds = uint(field(chainMatch, 'inspectionEnds', 4)).toString();
    record.rosterHash = field(chainMatch, 'rosterHash', 7);
    record.depositedCount = countMask(field(chainMatch, 'deposited', 10));
    record.readyCount = countMask(field(chainMatch, 'ready', 11));
    await commit(record, game);
    return { chainMatch, state };
  };
  const submitAndWait = async (record, contract, method, args, txField, game) => {
    const gasLimit = GAS_LIMITS[method];
    if (!gasLimit) throw new Error('Unapproved Fuji transaction method.');
    const cutoff = currentTime() - 60_000;
    while (transactionTimes.length && transactionTimes[0] <= cutoff) transactionTimes.shift();
    if (transactionTimes.length >= TX_BUDGET_PER_MINUTE) throw new Error('Fuji transaction rate limit reached; retry shortly.');
    transactionTimes.push(currentTime());
    const tx = await contract[method](...args, { gasLimit });
    if (tx?.hash) {
      record[txField] = tx.hash;
      await commit(record, game);
    }
    if (tx?.wait) await tx.wait();
  };
  const ensureCreate = async (record, game) => serialTransaction(async () => {
    const { state } = await recordMatchState(record, game);
    if (state !== STATE.none) return;
    record.status = 'creating';
    await commit(record, game);
    await submitAndWait(record, escrow, 'createMatch', [
      record.matchId, record.recipients, BigInt(record.stake), record.rulesHash, record.roleCommitment,
    ], 'txHash', game);
    const after = await recordMatchState(record, game);
    if (after.state !== STATE.funding) throw new Error('Escrow match creation was not confirmed on Fuji.');
  });

  async function prepare(game) {
    if (game?.phase !== 'lobby') throw new Error('Fuji escrow must be prepared before the game starts.');
    const recipients = checkRoster(ethers, game);
    if (game.chain?.matchId && store.get(game.chain.matchId)) {
      const existing = store.get(game.chain.matchId);
      assertSameRoster(existing, game, ethers);
      await ensureCreate(existing, game);
      attachGame(existing, game);
      return publicMatch(existing);
    }
    const matchId = ethers.hexlify((dependencies.randomBytes ?? randomBytes)(32));
    const roleSeed = ethers.hexlify((dependencies.randomBytes ?? randomBytes)(32));
    const roleCommitment = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(
      ['bytes32', 'bytes32'], [matchId, roleSeed],
    ));
    const record = {
      matchId, roleSeed, roleCommitment, rulesHash: makeRulesHash(ethers), rosterHash: ethers.ZeroHash,
      recipients: recipients.map((address) => address.toLowerCase()), stake, token: tokenAddress.toLowerCase(), escrow: escrowAddress.toLowerCase(),
      roomCode: String(game.code), status: 'creating', createdAt: '0', lockAt: '0', startAt: '0',
      inspectionEnds: '0', audit: null, canonicalEvents: null, outcome: null, payouts: null,
    };
    await store.put(record);
    game.chain = publicMatch(record);
    attachGame(record, game);
    await ensureCreate(record, game);
    return publicMatch(record);
  }

  async function start(game) {
    if (!game.chain?.matchId) await prepare(game);
    const record = getRecord(game);
    attachGame(record, game);
    assertSameRoster(record, game, ethers);
    const existingLock = recordLocks.get(`${record.matchId}:start`);
    if (existingLock) return existingLock;
    const operation = startImpl(game, record);
    recordLocks.set(`${record.matchId}:start`, operation);
    try { return await operation; } finally { recordLocks.delete(`${record.matchId}:start`); }
  }

  async function startImpl(game, record) {
    const deadline = BigInt(record.createdAt || 0) + FUNDING_WINDOW;
    let state;
    let chainMatch;
    while (true) {
      ({ chainMatch, state } = await recordMatchState(record, game));
      if (state === STATE.active) return rolesFromEnum(await escrowReader.rolesFor(record.matchId, record.roleSeed));
      if (state === STATE.locked) break;
      if (state !== STATE.funding) throw new Error(`Escrow cannot start from ${mapContractState(state)}.`);
      const deposits = Number(field(chainMatch, 'deposited', 10));
      const ready = Number(field(chainMatch, 'ready', 11));
      const block = await provider.getBlock('latest');
      if (BigInt(block.timestamp) >= deadline) throw new Error('Fuji funding window expired before all four seats were ready.');
      if (deposits === 15 && ready === 15) {
        await serialTransaction(() => submitAndWait(record, escrow, 'lockMatch', [record.matchId], 'lockTxHash', game));
        ({ chainMatch, state } = await recordMatchState(record, game));
        if (state === STATE.locked) break;
      } else {
        await (dependencies.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))))(
          Math.min(dependencies.pollIntervalMs ?? 1_000, 10_000),
        );
      }
    }

    const lockAt = BigInt(field(chainMatch, 'lockAt', 2));
    const freshBlock = await provider.getBlock('latest');
    const now = BigInt(freshBlock.timestamp);
    if (now >= lockAt + START_WINDOW) throw new Error('Escrow start window expired; on-chain timeout will refund this match.');
    const expiry = now + 30n < lockAt + START_WINDOW ? now + 30n : lockAt + START_WINDOW - 1n;
    if (expiry <= now) throw new Error('No valid start signature expiry remains.');
    const domain = { name: 'RageFridgeEscrow', version: '1', chainId: FUJI_CHAIN_ID, verifyingContract: escrowAddress };
    const types = { Start: [
      { name: 'matchId', type: 'bytes32' }, { name: 'rulesHash', type: 'bytes32' },
      { name: 'rosterHash', type: 'bytes32' }, { name: 'roleCommitment', type: 'bytes32' },
      { name: 'lockTimestamp', type: 'uint64' }, { name: 'expiry', type: 'uint64' },
    ] };
    const value = {
      matchId: record.matchId, rulesHash: record.rulesHash, rosterHash: record.rosterHash,
      roleCommitment: record.roleCommitment, lockTimestamp: lockAt, expiry,
    };
    const localDigest = ethers.TypedDataEncoder.hash(domain, types, value);
    const digest = await escrowReader.startDigest(record.matchId, expiry);
    if (digest.toLowerCase() !== localDigest.toLowerCase()) throw new Error('Escrow start digest does not match the Fuji EIP-712 domain.');
    const signatures = await Promise.all(signerWallets.slice(0, 2).map((wallet) => wallet.signTypedData(domain, types, value)));
    await serialTransaction(() => submitAndWait(record, escrow, 'startMatch', [record.matchId, expiry, signatures], 'startTxHash', game));
    const { state: activeState } = await recordMatchState(record, game);
    if (activeState !== STATE.active) throw new Error('Escrow start transaction did not activate the Fuji match.');
    record.roles = rolesFromEnum(await escrowReader.rolesFor(record.matchId, record.roleSeed));
    await commit(record, game);
    return [...record.roles];
  }

  async function complete(game) {
    const record = getRecord(game);
    attachGame(record, game);
    const existingLock = recordLocks.get(`${record.matchId}:complete`);
    if (existingLock) return existingLock;
    const operation = completeImpl(game, record);
    recordLocks.set(`${record.matchId}:complete`, operation);
    try { return await operation; } finally { recordLocks.delete(`${record.matchId}:complete`); }
  }

  async function completeImpl(game, record) {
    if (record.status === 'result-pending' || STORE_TERMINAL.has(record.status)) return publicMatch(record);
    if (game.phase !== 'ended' || !game.outcome) throw new Error('Only a finished game can be submitted for settlement.');
    assertSameRoster(record, game, ethers);
    const { state, chainMatch } = await recordMatchState(record, game);
    if (state !== STATE.active) throw new Error(`Cannot submit a result while escrow is ${mapContractState(state)}.`);
    const expectedRoles = rolesFromEnum(await escrowReader.rolesFor(record.matchId, record.roleSeed));
    if (!Array.isArray(game.audit?.roles) || game.audit.roles.some((role, i) => role !== expectedRoles[i])) {
      throw new Error('Game audit roles do not match the committed Fuji role seed.');
    }
    const verifyReplay = await maybeImportReplay(dependencies.verifyReplay);
    if (typeof verifyReplay !== 'function') throw new Error('Deterministic replay verifier is unavailable; result signing is disabled.');
    const replayed = await verifyReplay(game, expectedRoles);
    if (!replayed || !Array.isArray(replayed.events) || !replayed.outcome) {
      throw new Error('Replay verifier did not return a verified game.');
    }
    const canonicalEvents = canonicalFinancialEvents(game);
    if (canonicalJson(canonicalFinancialEvents(replayed)) !== canonicalJson(canonicalEvents)) {
      throw new Error('Verified replay events differ from the submitted game event log.');
    }
    if (canonicalJson(replayed.outcome) !== canonicalJson(game.outcome)) {
      throw new Error('Verified replay outcome differs from the submitted game outcome.');
    }
    const payouts = calculatePayouts(game.outcome.type, record.stake, game.outcome.players);
    const outcome = game.outcome.type === 'cold' ? 0 : game.outcome.type === 'sabotage' ? 1 : 2;
    const merkleRoot = orderedEventLogRoot(ethers, record.matchId, canonicalEvents);
    if (merkleRoot.toLowerCase() === ethers.ZeroHash.toLowerCase()) throw new Error('A nonempty canonical event log must have a nonzero root.');
    const auditRoster = game.audit.roster;
    if (!Array.isArray(auditRoster) || auditRoster.length !== 4 || auditRoster.some((player, index) =>
      String(player.id) !== String(game.players[index].id) || !player.wallet ||
      canonicalAddress(ethers, player.wallet).toLowerCase() !== record.recipients[index].toLowerCase())) {
      throw new Error('Replay audit roster does not match the wallet-bound escrow roster.');
    }
    const startTimestamp = uint(field(chainMatch, 'startAt', 3));
    const block = await provider.getBlock('latest');
    const now = BigInt(block.timestamp);
    if (now >= startTimestamp + RESULT_WINDOW) throw new Error('Escrow result window has expired; on-chain timeout will refund the match.');
    const expiry = now + 300n < startTimestamp + TERMINAL_TIMEOUT ? now + 300n : startTimestamp + TERMINAL_TIMEOUT - 1n;
    const result = {
      matchId: record.matchId, rulesHash: record.rulesHash, rosterHash: record.rosterHash,
      startTimestamp, outcome, roleSeed: record.roleSeed, merkleRoot, payouts, fee: 0n, expiry,
    };
    const domain = { name: 'RageFridgeEscrow', version: '1', chainId: FUJI_CHAIN_ID, verifyingContract: escrowAddress };
    const types = { Result: [
      { name: 'matchId', type: 'bytes32' }, { name: 'rulesHash', type: 'bytes32' },
      { name: 'rosterHash', type: 'bytes32' }, { name: 'startTimestamp', type: 'uint64' },
      { name: 'outcome', type: 'uint8' }, { name: 'roleSeed', type: 'bytes32' },
      { name: 'merkleRoot', type: 'bytes32' }, { name: 'payouts', type: 'uint256[4]' },
      { name: 'fee', type: 'uint256' }, { name: 'expiry', type: 'uint64' },
    ] };
    const localDigest = ethers.TypedDataEncoder.hash(domain, types, result);
    const digest = await escrowReader.resultDigest(result);
    if (digest.toLowerCase() !== localDigest.toLowerCase()) throw new Error('Escrow result digest does not match the Fuji EIP-712 domain.');

    record.audit = structuredClone(game.audit);
    record.canonicalEvents = canonicalEvents;
    record.outcome = outcome;
    record.payouts = payouts.map(String);
    record.merkleRoot = merkleRoot;
    record.startTimestamp = startTimestamp.toString();
    record.resultExpiry = expiry.toString();
    await commit(record, game);
    await serialTransaction(async () => {
      const before = await readMatch(record.matchId);
      const currentState = Number(field(before, 'state', 0));
      if (currentState !== STATE.active) {
        if (currentState === STATE.resultPending) return;
        throw new Error(`Escrow changed to ${mapContractState(currentState)} before result submission.`);
      }
      const signatures = await Promise.all(signerWallets.slice(0, 2).map((wallet) => wallet.signTypedData(domain, types, result)));
      await submitAndWait(record, escrow, 'submitResult', [result, signatures], 'resultTxHash', game);
    });
    await recordMatchState(record, game);
    if (record.status !== 'result-pending') throw new Error('Fuji did not accept the signed game result.');
    return publicMatch(record);
  }

  async function tick() {
    if (tickPromise) return tickPromise;
    tickPromise = (async () => {
      for (const record of store.all()) {
        if (STORE_TERMINAL.has(record.status)) continue;
        try {
          await serialTransaction(async () => {
            let chainMatch = await readMatch(record.matchId);
            let state = Number(field(chainMatch, 'state', 0));
            if (state === STATE.none && record.status === 'creating') {
              await submitAndWait(record, escrow, 'createMatch', [
                record.matchId, record.recipients, BigInt(record.stake), record.rulesHash, record.roleCommitment,
              ], 'txHash');
              chainMatch = await readMatch(record.matchId);
              state = Number(field(chainMatch, 'state', 0));
            }
            verifyOnchainRecord(record, chainMatch, state);
            record.status = mapContractState(state);
            record.createdAt = uint(field(chainMatch, 'createdAt', 1)).toString();
            record.lockAt = uint(field(chainMatch, 'lockAt', 2)).toString();
            record.startAt = uint(field(chainMatch, 'startAt', 3)).toString();
            record.inspectionEnds = uint(field(chainMatch, 'inspectionEnds', 4)).toString();
            record.rosterHash = field(chainMatch, 'rosterHash', 7);
            record.depositedCount = countMask(field(chainMatch, 'deposited', 10));
            record.readyCount = countMask(field(chainMatch, 'ready', 11));
            await store.put(record);
            if ([STATE.funding, STATE.locked, STATE.active, STATE.resultPending].includes(state)) {
              const block = await provider.getBlock('latest');
              const now = BigInt(block.timestamp);
              let method = null;
              if (state === STATE.funding && now >= uint(record.createdAt) + FUNDING_WINDOW) method = 'timeout';
              if (state === STATE.locked && now >= uint(record.lockAt) + START_WINDOW) method = 'timeout';
              if (state === STATE.active && now >= uint(record.startAt) + RESULT_WINDOW) method = 'timeout';
              if (state === STATE.resultPending) {
                if (now >= uint(record.startAt) + TERMINAL_TIMEOUT) method = 'timeout';
                else if (now >= uint(record.inspectionEnds)) method = 'finalize';
              }
              if (method) {
                await submitAndWait(record, escrow, method, [record.matchId], method === 'timeout' ? 'timeoutTxHash' : 'finalizeTxHash');
                chainMatch = await readMatch(record.matchId);
                record.status = mapContractState(Number(field(chainMatch, 'state', 0)));
                await store.put(record);
              }
            }
            notify(record);
          });
        } catch {
          // RPC/transaction failures remain retryable; never invent an outcome or overwrite chain state.
        }
      }
    })().finally(() => { tickPromise = null; });
    return tickPromise;
  }

  async function recover() {
    for (const record of store.all()) {
      try {
        let chainMatch = await readMatch(record.matchId);
        let state = Number(field(chainMatch, 'state', 0));
        if (state === STATE.none && record.status === 'creating') {
          await ensureCreate(record);
          chainMatch = await readMatch(record.matchId);
          state = Number(field(chainMatch, 'state', 0));
        }
        if (state === STATE.none) {
          throw new Error('A persisted Fuji match ID is missing from the configured escrow.');
        }
        verifyOnchainRecord(record, chainMatch, state);
        record.token = tokenAddress.toLowerCase();
        record.status = mapContractState(state);
        record.createdAt = uint(field(chainMatch, 'createdAt', 1)).toString();
        record.lockAt = uint(field(chainMatch, 'lockAt', 2)).toString();
        record.startAt = uint(field(chainMatch, 'startAt', 3)).toString();
        record.inspectionEnds = uint(field(chainMatch, 'inspectionEnds', 4)).toString();
        record.rosterHash = field(chainMatch, 'rosterHash', 7);
        record.depositedCount = countMask(field(chainMatch, 'deposited', 10));
        record.readyCount = countMask(field(chainMatch, 'ready', 11));
        await commit(record);
      } catch {
        throw new Error('Fuji startup recovery failed for a persisted match; check RPC, escrow configuration, and state storage.');
      }
    }
    await tick();
  }

  const coordinator = Object.freeze({
    publicConfig: () => config,
    isAllowedPlayer: (address) => typeof address === 'string' &&
      (!allowedPlayers.size || allowedPlayers.has(address.toLowerCase())),
    listMatches: (address, offset = 0) => {
      const account = canonicalAddress(ethers, address).toLowerCase();
      if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid history offset.');
      const records = store.all().filter((record) => record.recipients.some((recipient) => recipient.toLowerCase() === account)).reverse();
      return {
        matches: records.slice(offset, offset + 50).map((record) => publicMatch({ ...record, token: tokenAddress.toLowerCase() })),
        nextOffset: offset + 50 < records.length ? offset + 50 : null,
      };
    },
    prepare,
    start,
    complete,
    tick,
    close: async () => { if (typeof provider.destroy === 'function') await provider.destroy(); },
  });
  await recover();
  return coordinator;
}
