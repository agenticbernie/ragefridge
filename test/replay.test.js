import test from 'node:test';
import assert from 'node:assert/strict';
import { Game, rules } from '../server/game.js';
import { verifyReplay } from '../server/replay.js';

function endedGame() {
  const game = new Game('ABC123');
  game.paid = true;
  for (const [id, name, wallet] of [
    ['a', 'A', '0x0000000000000000000000000000000000000001'],
    ['b', 'B', '0x0000000000000000000000000000000000000002'],
    ['c', 'C', '0x0000000000000000000000000000000000000003'],
    ['d', 'D', '0x0000000000000000000000000000000000000004'],
  ]) {
    const player = game.addPlayer(id, name);
    player.wallet = wallet;
  }
  const roles = ['chef', 'chef', 'saboteur', 'stoic'];
  assert.equal(game.start('a', roles), null);
  for (let i = 0; i < rules.roleSeconds; i++) game.tick(1000 + i * 1000);
  assert.equal(game.submit('a', { action: 'roast', target: 'b', tier: 2 }), null);
  game.tick(12000);
  game.audit.inputs.push({ type: 'stop' });
  game.finish('void', 'safetyStop');
  return { game, roles };
}

test('financial replay reproduces actions, ticks, roles and safety stop', () => {
  const { game, roles } = endedGame();
  const replay = verifyReplay(game, roles);
  assert.equal(replay.phase, 'ended');
  assert.deepEqual(replay.outcome, game.outcome);
});

test('financial replay rejects tampered result and role roster', () => {
  const { game, roles } = endedGame();
  game.temperature += 1;
  assert.throws(() => verifyReplay(game, roles), /Replay mismatch/);
  game.temperature -= 1;
  assert.throws(() => verifyReplay(game, ['chef', 'saboteur', 'chef', 'stoic']), /inconsistent/);
});

test('post-result disconnect and reconnect cannot invalidate financial replay', () => {
  const { game, roles } = endedGame();
  const inputCount = game.audit.inputs.length;
  game.disconnect('a', 20_000);
  assert.equal(game.audit.inputs.length, inputCount);
  assert.equal(verifyReplay(game, roles).outcome.type, 'void');
  assert.equal(game.reconnect('a', 40_000), true);
  assert.equal(game.audit.inputs.length, inputCount);
  assert.deepEqual(verifyReplay(game, roles).outcome, game.outcome);
});
