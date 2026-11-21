import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import * as ethers from 'ethers';

// Only compiler-declared immutable bytes may differ from a reproducible local build.
export function verifyRuntime(actual, artifact) {
  const expected = artifact.deployedBytecode?.object;
  if (!/^0x(?:[0-9a-f]{2})+$/i.test(actual) || !/^0x(?:[0-9a-f]{2})+$/i.test(expected || '') || actual.length !== expected.length) {
    throw new Error('Runtime bytecode is missing or has a different length from the local build.');
  }
  const deployed = Buffer.from(actual.slice(2), 'hex');
  const compiled = Buffer.from(expected.slice(2), 'hex');
  for (const references of Object.values(artifact.deployedBytecode.immutableReferences || {})) {
    for (const { start, length } of references) {
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(length) || start < 0 || length <= 0 || start + length > compiled.length) {
        throw new Error('Invalid compiler immutable reference.');
      }
      deployed.fill(0, start, start + length);
      compiled.fill(0, start, start + length);
    }
  }
  if (!deployed.equals(compiled)) throw new Error('Runtime bytecode differs from the local build.');
}

export async function verifyFuji(env = process.env) {
  for (const name of ['FUJI_RPC_URL', 'CHAIN_TOKEN_ADDRESS', 'CHAIN_ESCROW_ADDRESS', 'CHAIN_EXPECTED_CREATOR', 'CHAIN_EXPECTED_SIGNERS']) {
    if (!env[name]?.trim()) throw new Error(`${name} is required.`);
  }
  const tokenAddress = ethers.getAddress(env.CHAIN_TOKEN_ADDRESS);
  const escrowAddress = ethers.getAddress(env.CHAIN_ESCROW_ADDRESS);
  const expectedCreator = ethers.getAddress(env.CHAIN_EXPECTED_CREATOR);
  const expectedSigners = env.CHAIN_EXPECTED_SIGNERS.split(',').map((address) => ethers.getAddress(address.trim()));
  if (expectedSigners.length !== 3 || new Set(expectedSigners).size !== 3 || expectedSigners.includes(ethers.ZeroAddress)) {
    throw new Error('Three distinct nonzero expected signers are required.');
  }
  const provider = new ethers.JsonRpcProvider(env.FUJI_RPC_URL);
  try {
    if ((await provider.getNetwork()).chainId !== 43113n) throw new Error('RPC must be Avalanche Fuji (43113).');
    const blockNumber = await provider.getBlockNumber();
    const [tokenArtifact, escrowArtifact] = await Promise.all([
      readFile(new URL('../chain/out/TestCredit.sol/TestCredit.json', import.meta.url), 'utf8').then(JSON.parse),
      readFile(new URL('../chain/out/RageFridgeEscrow.sol/RageFridgeEscrow.json', import.meta.url), 'utf8').then(JSON.parse),
    ]);
    const [tokenCode, escrowCode] = await Promise.all([
      provider.getCode(tokenAddress, blockNumber), provider.getCode(escrowAddress, blockNumber),
    ]);
    verifyRuntime(tokenCode, tokenArtifact);
    verifyRuntime(escrowCode, escrowArtifact);
    const escrow = new ethers.Contract(escrowAddress, escrowArtifact.abi, provider);
    const options = { blockTag: blockNumber };
    const [configuredToken, creator, signers] = await Promise.all([
      escrow.token(options), escrow.creator(options), Promise.all([0, 1, 2].map((index) => escrow.signers(index, options))),
    ]);
    if (configuredToken !== tokenAddress || creator !== expectedCreator || signers.some((address, index) => address !== expectedSigners[index])) {
      throw new Error('Escrow immutable configuration or signer order differs from the expected deployment.');
    }
    return { chainId: 43113, blockNumber, token: tokenAddress, escrow: escrowAddress, creator, signers,
      tokenCodeHash: ethers.keccak256(tokenCode), escrowCodeHash: ethers.keccak256(escrowCode),
      verifiedAt: new Date().toISOString(), realValueEnabled: false };
  } finally { provider.destroy(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { console.log(JSON.stringify(await verifyFuji(), null, 2)); }
  catch { console.error('Fuji verification failed. Check RPC, public expected addresses, and forge build artifacts. No transaction was sent.'); process.exitCode = 1; }
}
