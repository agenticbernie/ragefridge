import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyRuntime, verifyFuji } from '../scripts/verify-fuji.js';
import { readFile } from 'node:fs/promises';
import { DEFAULT_TOKEN_ADDRESS, DEFAULT_ESCROW_ADDRESS } from '../server/chain.js';
import { getAddress } from 'ethers';

test('default Fuji contracts and environment example agree with recorded deployment', async () => {
  const deployment = JSON.parse(await readFile(new URL('../docs/deployments/fuji.json', import.meta.url), 'utf8'));
  const example = await readFile(new URL('../.env.example', import.meta.url), 'utf8');
  assert.equal(deployment.chainId, 43113);
  assert.equal(DEFAULT_TOKEN_ADDRESS, deployment.token.toLowerCase());
  assert.equal(DEFAULT_ESCROW_ADDRESS, deployment.escrow.toLowerCase());
  for (const [key, value] of Object.entries({ CHAIN_TOKEN_ADDRESS: deployment.token, CHAIN_ESCROW_ADDRESS: deployment.escrow,
    CHAIN_EXPECTED_CREATOR: deployment.creator, CHAIN_EXPECTED_SIGNERS: deployment.signers.join(',') })) {
    assert.ok(example.split('\n').includes(`${key}=${value}`));
  }
  assert.equal(new Set(deployment.signers.map(getAddress)).size, 3);
  assert.equal(deployment.realValueEnabled, false);
  assert.ok(example.split('\n').includes('CHAIN_ENABLED=false'));
});

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
