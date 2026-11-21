import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyRuntime, verifyFuji } from '../scripts/verify-fuji.js';

test('deployment verifier permits only declared immutable offsets to vary', () => {
  const artifact = { deployedBytecode: { object: '0x6000006001', immutableReferences: { creator: [{ start: 1, length: 2 }] } } };
  verifyRuntime('0x60abcd6001', artifact);
  assert.throws(() => verifyRuntime('0x60abcd6002', artifact), /differs/);
  assert.throws(() => verifyRuntime('0x', artifact), /missing/);
  assert.throws(() => verifyRuntime('0x600000', artifact), /length/);
  assert.throws(() => verifyRuntime('0x60abcd6001', { deployedBytecode: { ...artifact.deployedBytecode, immutableReferences: {} } }), /differs/);
  assert.throws(() => verifyRuntime('0x60abcd6001', { deployedBytecode: { ...artifact.deployedBytecode,
    immutableReferences: { bad: [{ start: 4, length: 2 }] } } }), /Invalid compiler/);
});

test('deployment verification requires explicit public expectations before accessing RPC', async () => {
  await assert.rejects(verifyFuji({}), /FUJI_RPC_URL is required/);
  await assert.rejects(verifyFuji({ FUJI_RPC_URL: 'https://unused.invalid' }), /CHAIN_TOKEN_ADDRESS/);
});
