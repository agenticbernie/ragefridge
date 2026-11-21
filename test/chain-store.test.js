import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, stat, readdir, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonChainStore } from '../server/chain-store.js';

const id = (number) => `0x${number.toString(16).padStart(64, '0')}`;
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'ragefridge-store-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('chain store persists concurrent writes and recovers private records on restart', async (t) => {
  const directory = await fixture(t);
  const store = await new JsonChainStore(directory).init();
  await Promise.all(Array.from({ length: 20 }, (_, index) => store.put({ matchId: id(index), status: 'funding' })));
  const restarted = await new JsonChainStore(directory).init();
  assert.equal(restarted.all().length, 20);
  assert.equal(restarted.get(id(4)).status, 'funding');
  assert.equal((await stat(directory)).mode & 0o777, 0o700);
  assert.equal((await stat(store.path)).mode & 0o777, 0o600);
  assert.deepEqual(await readdir(directory), ['matches.json']);
});

test('chain store does not expose mutable in-memory records', async (t) => {
  const store = await new JsonChainStore(await fixture(t)).init();
  const record = { matchId: id(1), nested: { status: 'funding' } };
  await store.put(record);
  record.nested.status = 'changed';
  store.get(id(1)).nested.status = 'changed';
  store.all()[0].nested.status = 'changed';
  assert.equal(store.get(id(1)).nested.status, 'funding');
  assert.equal(JSON.parse(await readFile(store.path, 'utf8'))[0].nested.status, 'funding');
});

test('chain store rejects corruption and duplicate IDs without partially loading state', async (t) => {
  const directory = await fixture(t);
  const path = join(directory, 'matches.json');
  for (const contents of ['{', '{}', '[{"matchId":"bad"}]', JSON.stringify([{ matchId: id(1) }, { matchId: id(1) }])]) {
    await writeFile(path, contents);
    const store = new JsonChainStore(directory);
    await assert.rejects(store.init());
    assert.equal(store.initialized, false);
    assert.deepEqual(store.all(), []);
  }
});

test('chain store rejects invalid writes and symlink state files', async (t) => {
  const directory = await fixture(t);
  const store = await new JsonChainStore(directory).init();
  await assert.rejects(store.put({ matchId: 'bad' }), /valid match ID/);
  const target = join(directory, 'target.json');
  await writeFile(target, '[]');
  await symlink(target, store.path);
  await assert.rejects(new JsonChainStore(directory).init());
  assert.equal(await readFile(target, 'utf8'), '[]');
});
