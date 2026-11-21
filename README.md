# RageFridge

RageFridge is a four-player, real-time social-deduction game prototype. Trade authored kitchen roasts to cool a shared refrigerator while managing your own cartoon BP meter. The game server is authoritative for roles, actions, timing, temperature, and match results.

## Run locally

Requirements: Node.js 20 or newer. `.node-version` records the version used for this workspace.

```sh
npm ci
npm start
```

Open `http://localhost:10000`. Free rooms and the single-browser bot demo are available without a wallet. The game uses authored actions only; typed text is not scored.

## Verify

```sh
npm test
(cd chain && forge test)
npm run test:browser
```

The browser smoke test requires a locally installed Chromium (`CHROMIUM_BIN` can override its executable path). It exercises the bot demo, role reveal, an authored roast, and Safety Stop, then a **mocked** wallet-history flow (pagination, claim, authentication expiry, account changes, and dialog races). It does not send Fuji transactions.

## Project map

- `public/` — browser client, styles, and original SVG artwork.
- `server/` — WebSocket game server, deterministic game engine, wallet sign-in, replay verification, and optional Fuji coordinator.
- `chain/src/` — RFC test token, Fuji escrow, ordered event-log library, and reference ERC-4337 policy library.
- `chain/test/` — Foundry contract and policy tests.
- `docs/` — game pitch, rules/balance, and UX/art design handoff.
- `docs/IMPLEMENTATION-STATUS.md` — what is implemented and the remaining completion gates.

## Safety and deployment status

The default deployment has `CHAIN_ENABLED=false`. RFC is a test credit, not a real-value asset. Do not enable chain mode with real funds. The current browser uses an injected EOA and separate wallet transactions; it is **not** the planned embedded Smart Account, atomic ERC-4337 entry, or gas-sponsored flow. The Solidity policy is a reference library and test fixture, not a deployed wallet validator or paymaster. See the implementation status for the release blockers and gaps.

Optional chain mode requires a verified Fuji RPC, deployed/tested RFC and escrow addresses, creator and quorum keys, and a persistent private `CHAIN_STATE_DIR`. Never commit secrets or use production funds. `CHAIN_ALLOWED_PLAYERS` can restrict EOA addresses; without it, the Fuji test room is not invite-restricted. Set `PUBLIC_ORIGIN` to the canonical HTTPS origin for production wallet sign-in.

### Claim recovery

When Fuji mode is enabled, **FUJI CLAIM HISTORY** lets an authenticated wallet retrieve its matches from this server's persistent coordinator store, 50 per page, without retaining a gameplay seat. Claim buttons re-read the contract: only settled payouts and refundable deposits can be claimed. An expired sign-in requires a new signature; switching wallet/account invalidates the displayed history.

Submitted transaction hashes are saved in browser local storage when available and checked before another transaction is sent. If storage is disabled or cleared, use the wallet's transaction history to verify outstanding transactions before retrying. Do not operate multiple tabs concurrently. No wallet signature, private key, or bearer session is stored in local storage. History recovery is **not** durable gameplay-seat recovery: active rooms remain in server memory.

### Operator tools

The operator deployed the Fuji test token at `0xdB327028a1F07E6aAC4B95b3cF23bC4239Dc62fc` and escrow at `0xCbB37BE2c4df698FcBBb41B44A3d1cbBeFEF7943`. Creation receipts, runtime bytecode and public configuration were checked over Fuji RPC; see [the deployment record](docs/deployments/fuji.json). Explorer source verification is operator-reported; live four-wallet gameplay remains unverified.

Follow [the Render deployment guide](docs/RENDER-DEPLOYMENT.md) to host the web app and configure this deployment. See [the Fuji runbook](docs/FUJI-OPERATIONS.md) for simulation-first deployment and read-only bytecode/configuration verification. Chain mode stays disabled by default; enabling it requires operator keys and persistent storage.

The server bounds room attempts across sockets (60 per minute per socket IP), rooms (1,000), and WebSocket connections (512 overall, 32 per socket IP). Limits are single-process and do not trust forwarded headers. Behind a reverse proxy, clients may share its IP: enforce appropriate public limits at the proxy and review these defaults before opening access.
