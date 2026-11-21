import { isDeepStrictEqual } from 'node:util';
import { Game } from './game.js';

// This checks deterministic consistency, not independent operator honesty.
export function verifyReplay(game, expectedRoles) {
  const audit = game.audit;
  if (!audit || game.demo || game.phase !== 'ended' || audit.roster.length !== 4 ||
      !isDeepStrictEqual(audit.roles, expectedRoles) || audit.inputs.length > 10000) {
    throw new Error('Missing or inconsistent financial replay.');
  }
  const replay = new Game(game.code);
  for (const seat of audit.roster) {
    const player = replay.addPlayer(seat.id, seat.name);
    player.wallet = seat.wallet;
  }
  if (replay.start(audit.hostId, expectedRoles)) throw new Error('Invalid replay start.');
  let lastTime = -Infinity;
  for (const input of audit.inputs) {
    if (replay.phase === 'ended') throw new Error('Replay input after terminal outcome.');
    if (input.now !== undefined) {
      if (!Number.isFinite(input.now) || input.now < lastTime) throw new Error('Nonmonotonic replay clock.');
      lastTime = input.now;
    }
    if (input.type === 'tick') replay.tick(input.now);
    else if (input.type === 'submit') {
      if (replay.submit(input.id, input.message)) throw new Error('Rejected replay action.');
    } else if (input.type === 'disconnect') replay.disconnect(input.id, input.now);
    else if (input.type === 'reconnect') {
      if (!replay.reconnect(input.id, input.now)) throw new Error('Invalid replay reconnection.');
    } else if (input.type === 'stop' || input.type === 'void') {
      replay.finish('void', input.type === 'stop' ? 'safetyStop' : 'serverTiming');
    } else throw new Error('Unknown replay input.');
  }
  for (const key of ['phase', 'elapsed', 'roleRemaining', 'temperature', 'coldHold', 'events', 'outcome', 'totalReceipts']) {
    if (!isDeepStrictEqual(replay[key], game[key])) throw new Error(`Replay mismatch: ${key}.`);
  }
  const playerState = (players) => players.map((p) => Object.fromEntries(
    // Transport state may change while result signing awaits RPC. It is not financial state after finish.
    ['id', 'name', 'wallet', 'role', 'alive', 'bp', 'peakBP',
      'lastIncrease', 'scoredReady', 'restReady', 'restUntil', 'deflectReady', 'shieldUntil',
      'receipts'].map((key) => [key, p[key]]),
  ));
  if (!isDeepStrictEqual(playerState(replay.players), playerState(game.players))) {
    throw new Error('Replay mismatch: player state.');
  }
  if (!isDeepStrictEqual(audit.roster.map((seat) => seat.id), game.players.map((seat) => seat.id))) {
    throw new Error('Replay roster changed.');
  }
  return replay;
}
