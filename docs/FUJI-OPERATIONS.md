# Fuji operator runbook

This is a test-credit deployment procedure. The operator's deployed token/escrow, successful receipts and read-only runtime/configuration verification are recorded in [deployments/fuji.json](deployments/fuji.json). Source verification is operator-reported; live four-wallet gameplay remains unverified. Follow [RENDER-DEPLOYMENT.md](RENDER-DEPLOYMENT.md) to host the web app with these contracts. Keep `CHAIN_ENABLED=false` until operator configuration and persistent storage are ready, then validate with an explicit test-wallet allowlist. Never use production funds or production wallet keys.

## 1. Build and simulate locally

Use the pinned Solidity compiler in `chain/foundry.toml`. Three distinct nonzero signer addresses are required. Example addresses below are simulation fixtures, not production identities.

```sh
cd chain
forge build
forge test
forge script script/DeployFuji.s.sol:DeployFuji \
  --sig 'run(address[3])' \
  '[0x0000000000000000000000000000000000000001,0x0000000000000000000000000000000000000002,0x0000000000000000000000000000000000000003]' \
  --chain-id 43113
```

This executes locally only. Returned addresses are **not live deployments**. The script rejects other chains and invalid signer sets. It deploys the test token and escrow; the broadcasting account becomes escrow creator. It does not deploy ERC-4337 accounts or a paymaster.

## 2. Prepare a Fuji deployment

- Use a dedicated, Fuji-only creator account with test AVAX and encrypted Foundry keystore. Do not put keys in command-line arguments or git.
- Choose three independently controlled signer addresses. Server quorum operation currently requires at least two of their private keys; it is a trusted-operator model, not independent consensus.
- Set `FUJI_RPC_URL`, `CHAIN_EXPECTED_CREATOR`, and a comma-separated, ordered `CHAIN_EXPECTED_SIGNERS` containing public addresses. Build a shell `SIGNER_ARRAY` in the same array format as above using the real public signer addresses.
- Simulate against the actual RPC using `--rpc-url "$FUJI_RPC_URL" --sender "$CHAIN_EXPECTED_CREATOR"`, without `--broadcast`. Review token/escrow addresses, gas estimate, chain ID and all constructor arguments.
- Only after explicit operator approval, rerun with the chosen encrypted `--account` and `--broadcast`. This spends test AVAX. Never infer permission to broadcast from a passing local simulation.
- Keep the Foundry transaction receipts and record confirmed token/escrow addresses. Do not reuse the example or default addresses without verification.

## 3. Read-only verification

From the repository root, export the confirmed `CHAIN_TOKEN_ADDRESS`, `CHAIN_ESCROW_ADDRESS`, `FUJI_RPC_URL`, `CHAIN_EXPECTED_CREATOR`, and ordered `CHAIN_EXPECTED_SIGNERS` public values, then:

```sh
npm run verify:fuji
```

The verifier checks RPC chain ID, runtime bytecode against local compiler artifacts (only compiler-declared immutable offsets may vary), escrow token/creator, and all three signers at one block number. It outputs a public JSON snapshot with code hashes. It needs **no private keys** and sends **no transactions**. A passing snapshot is point-in-time evidence, not a contract audit or reorg guarantee. Save it with the deployment receipts; do not save RPC URLs containing credentials.

## 4. Enable the coordinator cautiously

- Supply secrets through the hosting platform, not committed files. `.env.example` is not automatically loaded by `npm start`.
- Set canonical HTTPS `PUBLIC_ORIGIN` and explicit `CHAIN_ALLOWED_PLAYERS` during validation.
- Set the verified token/escrow addresses, `CHAIN_CREATOR_KEY`, and at least two distinct `CHAIN_SIGNER_KEYS` matching the deployment.
- Mount a private persistent `CHAIN_STATE_DIR` outside `public/`; run exactly **one writer/instance**. File permissions do not enforce single-writer operation. Never share it between server processes.
- Back up the state directory while the coordinator is stopped; test restoring to a private staging environment. It contains private role seeds and replay evidence and must not be served or logged.
- Use HTTPS/WSS and proxy-level abuse protection. The built-in IP limits use direct socket addresses, so reverse-proxied clients can share one limit. Do not blindly trust `X-Forwarded-For`.
- Start with `CHAIN_ENABLED=true` only after the above checks. Startup refuses missing deployments/configuration or inconsistent persisted records.

## 5. Validate and recover

Run four-wallet tests for funding, ready/start, signature quorum, result inspection/finalization, claims, Safety Stop refunds, wallet switching and refresh. Include creator gas exhaustion, RPC interruption, process restart and expired-match timeout cases. Local mocked tests are not substitutes for these Fuji checks.

After restart the coordinator reconciles persisted records and finalizes pending results or times out expired matches. It does **not** resurrect active gameplay or automatically reconstruct and resubmit every unbroadcast result. Missing live gameplay can reach the timeout refund path. Users can sign in to claim history after settlement/refund independently of their seat.

For uncertain transactions, inspect the existing hash and receipt first; do not immediately resend. A browser hash journal is a convenience, not a wallet replacement or cross-tab lock. Investigate pending/replaced transactions using the wallet and explorer. If RPC or state storage is corrupt, keep chain mode disabled; do not delete the store to bypass recovery checks.

## Still required before release

Live four-wallet gameplay/claim evidence, independently checked explorer source verification, independent security review, distributed key custody, production monitoring/backup drills, ERC-4337/paymaster integration if promised, and the product/privacy/legal gates in `IMPLEMENTATION-STATUS.md` remain outstanding. Deployed runtime/configuration and creation receipts have been checked separately; they do not establish these release gates.
