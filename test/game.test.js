import test from 'node:test';
import assert from 'node:assert/strict';
import { Game, rules } from '../server/game.js';

function room() {
  const game = new Game('ABC123');
  for (const [id, name] of [['a', 'A'], ['b', 'B'], ['c', 'C'], ['d', 'D']]) game.addPlayer(id, name);
  assert.equal(game.start('a', ['chef', 'chef', 'saboteur', 'stoic']), null);
  for (let i = 0; i < rules.roleSeconds; i++) game.tick(Date.now());
  assert.equal(game.phase, 'active');
  return game;
}
function tick(game) { game.tick(Date.now()); }

test('lobby requires four seats and only host can start', () => {
  const game = new Game('ROOM');
  game.addPlayer('a', 'A'); game.addPlayer('b', 'B');
  assert.match(game.start('b'), /host/);
  assert.match(game.start('a'), /four/);
  game.addPlayer('c', 'C'); game.addPlayer('d', 'D');
  assert.equal(game.start('a', ['chef', 'chef', 'saboteur', 'stoic']), null);
  assert.deepEqual(game.snapshot('a').players.map((p) => p.role), [undefined, undefined, undefined, undefined]);
  for (let i = 0; i < 10; i++) tick(game);
  assert.equal(game.snapshot('a').players[0].role, undefined);
  assert.equal(game.snapshot('a').you.role, 'chef');
});

test('wallet lobby start waits for four on-chain deposits and ready confirmations', () => {
  const game = new Game('CHAIN1');
  game.paid = true;
  game.chain = { state: 'FUNDING', depositedCount: 4, readyCount: 3 };
  for (const [id, name] of [['a', 'A'], ['b', 'B'], ['c', 'C'], ['d', 'D']]) game.addPlayer(id, name);
  assert.equal(game.snapshot('a').canStart, false);
  game.chain.readyCount = 4;
  assert.equal(game.snapshot('a').canStart, true);
  assert.equal(game.snapshot('b').canStart, false);
});

test('authored roast queues deterministic cooling and BP costs', () => {
  const game = room();
  assert.equal(game.submit('a', { action: 'roast', target: 'b', tier: 2 }), null);
  assert.equal(game.snapshot('a').you.pending, true);
  tick(game);
  assert.equal(game.temperature, 16.2 * 100);
  assert.equal(game.getPlayer('a').bp, 17 * 100);
  assert.equal(game.getPlayer('b').bp, 14 * 100);
  assert.equal(game.events.at(-1).tier, 2);
});

test('global cooldown covers roast and compliment and rejects self targeting', () => {
  const game = room();
  assert.equal(game.submit('a', { action: 'roast', target: 'b', tier: 1 }), null);
  tick(game);
  assert.match(game.submit('a', { action: 'compliment', target: 'b' }), /cooldown/);
  assert.match(game.submit('b', { action: 'roast', target: 'b', tier: 1 }), /another/);
  for (let i = 0; i < 5; i++) tick(game);
  assert.equal(game.submit('a', { action: 'compliment', target: 'b' }), null);
});

test('pair repeat attenuates cooling and target BP, exact boundary is unattenuated', () => {
  const game = room();
  assert.equal(game.submit('a', { action: 'roast', target: 'b', tier: 1 }), null); tick(game);
  for (let i = 0; i < 5; i++) tick(game);
  assert.equal(game.submit('a', { action: 'roast', target: 'b', tier: 2 }), null); tick(game);
  assert.equal(game.events.at(-1).repeat, true);
  // Advance until the pair window is exactly 12 seconds from the accepted roast.
  for (let i = 0; i < 11; i++) tick(game);
  assert.equal(game.submit('a', { action: 'roast', target: 'b', tier: 3 }), null); tick(game);
  assert.equal(game.events.at(-1).repeat, false);
});

test('duplicate and target protection preserve speaker cost but prevent effect', () => {
  const game = room();
  assert.equal(game.submit('a', { action: 'roast', target: 'b', tier: 1 }), null); tick(game);
  for (let i = 0; i < 6; i++) tick(game);
  // Same tier within duplicate window: speaker pays, target gets no new BP/cooling.
  const beforeTemp = game.temperature; const beforeTarget = game.getPlayer('b').bp;
  assert.equal(game.submit('a', { action: 'roast', target: 'b', tier: 1 }), null); tick(game);
  assert.equal(game.events.at(-1).reason, 'duplicate');
  assert.equal(game.temperature, beforeTemp + rules.ambientHeat * 100);
  assert.ok(game.getPlayer('b').bp <= beforeTarget); // no target BP is added by the duplicate
  // Two distinct effective roasts in a rolling window protect subsequent incoming events.
  const g = room();
  for (const [speaker, tier] of [['a', 1], ['c', 2]]) {
    assert.equal(g.submit(speaker, { action: 'roast', target: 'b', tier }), null); tick(g);
    if (speaker === 'a') for (let i = 0; i < 6; i++) tick(g);
  }
  assert.equal(g.submit('d', { action: 'roast', target: 'b', tier: 1 }), null); tick(g);
  assert.equal(g.events.at(-1).reason, 'protected');
});

test('rest and deflect have independent cooldowns and deflect is consumed once', () => {
  const game = room();
  assert.equal(game.submit('b', { action: 'deflect', target: 'b' }), null);
  assert.equal(game.submit('b', { action: 'rest' }), null);
  assert.match(game.submit('b', { action: 'roast', target: 'a', tier: 1 }), /resting/);
  assert.equal(game.submit('a', { action: 'roast', target: 'b', tier: 3 }), null); tick(game);
  assert.equal(game.getPlayer('b').bp, 10 * 100); // rest recovery cancels the deflected +3 BP
  assert.equal(game.getPlayer('b').shieldUntil, 0);
});

test('ungraded text has no physics or BP effect but consumes cooldown', () => {
  const game = room();
  const temperature = game.temperature; const bp = game.getPlayer('a').bp;
  assert.equal(game.submit('a', { action: 'roast', target: 'b', tier: 3, text: 'hello' }), null); tick(game);
  assert.equal(game.temperature, temperature + rules.ambientHeat * 100);
  assert.equal(game.getPlayer('a').bp, bp);
  assert.equal(game.events.at(-1).type, 'ungraded');
});

test('overheat gives sabotage win only while saboteur is alive', () => {
  const game = room();
  game.temperature = 99.9 * 100;
  tick(game);
  assert.equal(game.phase, 'ended');
  assert.equal(game.outcome.type, 'sabotage');
  const noSaboteur = room();
  noSaboteur.getPlayer('c').alive = false;
  noSaboteur.temperature = 99.9 * 100;
  tick(noSaboteur);
  assert.equal(noSaboteur.outcome.type, 'draw');
});

test('cold victory requires ten consecutive end-of-tick seconds', () => {
  const game = room();
  for (let i = 0; i < rules.duration - 1; i++) {
    game.temperature = -30 * 100;
    tick(game);
  }
  assert.equal(game.phase, 'suddenDeath');
  tick(game);
  assert.equal(game.outcome.type, 'cold');
});

test('safety stop and disconnect grace produce void/elimination state', () => {
  const game = room();
  game.finish('void', 'safetyStop');
  assert.equal(game.outcome.type, 'void');
  const disconnected = room();
  disconnected.disconnect('b', 0);
  disconnected.tick((rules.disconnectGrace + 1) * 1000);
  assert.equal(disconnected.getPlayer('b').alive, false);
});

test('disconnected seats cannot be targeted, while already queued actions still resolve', () => {
  const game = room();
  game.disconnect('b', 0);
  assert.match(game.submit('a', { action: 'roast', target: 'b', tier: 1 }), /connected/);

  const queued = room();
  assert.equal(queued.submit('a', { action: 'roast', target: 'b', tier: 2 }), null);
  queued.disconnect('b', 0);
  tick(queued);
  assert.equal(queued.events.at(-1).type, 'roast');
  assert.equal(queued.events.at(-1).target, 'b');
});

test('passive recovery starts at three seconds and Rest lasts exactly four ticks', () => {
  const game = room();
  const player = game.getPlayer('a');
  player.bp = 3000;
  player.lastIncrease = 0;
  tick(game);
  tick(game);
  assert.equal(player.bp, 3000);
  tick(game);
  assert.equal(player.bp, 2950);
  assert.equal(game.submit('a', { action: 'rest' }), null);
  for (let index = 0; index < 4; index++) tick(game);
  assert.equal(player.bp, 1550);
  tick(game);
  assert.equal(player.bp, 1500);
});

test('the net event cap bounds cooling without reducing speaker costs', () => {
  const game = room();
  assert.equal(game.submit('a', { action: 'roast', target: 'b', tier: 3 }), null);
  assert.equal(game.submit('c', { action: 'roast', target: 'd', tier: 3 }), null);
  tick(game);
  assert.equal(game.temperature, 1420);
  assert.equal(game.getPlayer('a').bp, 2100);
  assert.equal(game.getPlayer('c').bp, 2100);
  assert.equal(game.totalReceipts, 2);
});

test('scored requests close at second 298 and overheat takes priority at the final tick', () => {
  const game = room();
  game.elapsed = 298;
  assert.match(game.submit('a', { action: 'roast', target: 'b', tier: 1 }), /too late/);
  game.elapsed = 299;
  game.coldHold = 10;
  game.temperature = 9990;
  tick(game);
  assert.equal(game.outcome.type, 'sabotage');
  assert.equal(game.outcome.reason, 'overheat');
});

test('Stoic requires strict majority and peak BP at most twenty for the special weight', () => {
  for (const [receipts, total, peakBP, expected] of [[6, 12, 2000, 125], [7, 13, 2000, 200], [7, 13, 2001, 125]]) {
    const game = room();
    const stoic = game.getPlayer('d');
    stoic.receipts = receipts;
    stoic.peakBP = peakBP;
    game.totalReceipts = total;
    game.finish('cold', 'coldHold');
    assert.equal(game.outcome.players.find((player) => player.id === 'd').weight, expected);
  }
});
