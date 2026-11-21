# Deploy RageFridge on Render

Use a **Node Web Service**, not a Static Site: the server hosts both the browser assets and WebSocket gameplay. `render.yaml` is a free-demo Blueprint with chain mode disabled; it does not provision a persistent disk or operator secrets.

## 1. Deploy the web app with chain disabled

In Render Dashboard, choose **New → Web Service**, connect `agenticbernie/ragefridge`, and set:

| Setting | Value |
| --- | --- |
| Branch | `main` (after the deployment-address update is pushed) |
| Root directory | Leave empty |
| Runtime | Node |
| Build command | `npm ci` |
| Start command | `npm start` |
| Health check path | `/healthz` |
| Node version environment variable | `NODE_VERSION=24.22.1` |
| Initial chain flag | `CHAIN_ENABLED=false` |

Render supplies `PORT`. No separate frontend build, RPC proxy, or WebSocket service is required. Free compute is suitable only for a free-play preview, not the chain coordinator.

Deploy, then set `PUBLIC_ORIGIN` to the exact public HTTPS origin, for example `https://your-service.onrender.com` (no trailing slash or path). Redeploy and confirm `/healthz` returns 200 and the free bot demo works. Change this value if you later use a custom domain, and use that canonical domain for wallet sign-in.

## 2. Prepare persistent chain operation

Before enabling chain mode, explicitly approve the cloud charges and choose paid compute supporting a persistent disk. Add a disk mounted at `/var/data`; configure the app's private child directory as `/var/data/ragefridge`. Only files under the mount survive redeploys. Do not mount inside `public/`.

Run **one service instance and one Node process**. Do not run another local coordinator against the same escrow while this service operates it. The current file store is single-writer, not a distributed database. Do not rely on an arbitrary folder on Render Free: that filesystem is ephemeral and Free cannot attach a persistent disk.

## 3. Configure the deployed Fuji contracts

The deployment is recorded in [deployments/fuji.json](deployments/fuji.json). Both successful creation receipts were checked at block `61431307`; runtime/configuration checks passed at block `61431567`. Explorer source verification was reported by the operator, not independently checked by this repository update. Live four-wallet gameplay is still unverified.

In the service's **Environment** page, set these public configuration values:

```dotenv
FUJI_RPC_URL=https://api.avax-test.network/ext/bc/C/rpc
CHAIN_TOKEN_ADDRESS=0xdB327028a1F07E6aAC4B95b3cF23bC4239Dc62fc
CHAIN_ESCROW_ADDRESS=0xCbB37BE2c4df698FcBBb41B44A3d1cbBeFEF7943
CHAIN_STAKE=10000000000000000000
CHAIN_STATE_DIR=/var/data/ragefridge
```

Also retain `NODE_VERSION=24.22.1` and your actual `PUBLIC_ORIGIN`. The public RPC is adequate for initial testing but may throttle; monitor it and choose a suitable provider for sustained operation.

Add private values directly to Render's environment settings, never to GitHub, frontend code, screenshots or chat:

| Variable | Required value |
| --- | --- |
| `CHAIN_CREATOR_KEY` | Private key of **`0xD7A9788d08140237abBc482BF7981647Eb0419A1`**, prefixed with `0x` |
| `CHAIN_SIGNER_KEYS` | At least two distinct deployed signers' private keys, comma-separated, each prefixed with `0x` |
| `CHAIN_ALLOWED_PLAYERS` | Explicit comma-separated player wallet addresses for initial testing; these are public addresses, not keys |

Deployed signers, in constructor order:

1. `0x9DDCeb36F344b885Fe9D49fB5518a4643d4fafB6`
2. `0x823C7C16eE96b840A83b9bC0612a7C80ee10B632`
3. `0xBf3Ce627AF783d46fcC9207EeF4B24EfB03127Ce`

You must control the corresponding keys; contract addresses cannot substitute for them. If keys were lost, do not invent replacement values: the current escrow has no signer/creator rotation function. The coordinator is a trusted-operator model, not independently distributed quorum custody.

Keep test AVAX in the creator account for create/lock/start/result/finalize/timeout operations. Each player's EOA also needs test AVAX for its own transactions. Signers need no gas solely to sign typed messages. `CHAIN_EXPECTED_CREATOR` and `CHAIN_EXPECTED_SIGNERS` are optional local-verifier inputs, not server startup requirements. `.env.example` is documentation and is not automatically loaded.

Once the disk and all secrets are ready, set `CHAIN_ENABLED=true`, save and deploy. This is the only activation flag; address updates alone do not enable chain mode.

## 4. Acceptance checks

1. Confirm Render logs show a successful server start, not recovery/configuration failure.
2. Visit `/healthz` and `/api/chain/config`: confirm `enabled: true`, chain ID `43113`, and the token/escrow above. These endpoints do not prove complete gameplay readiness.
3. Use four distinct allowed wallets on Fuji, in separate browser profiles. Fund all with test AVAX and assemble all players before funding; the funding window is 120 seconds.
4. Create/join the Fuji room, mint RFC if needed, approve the exact stake, deposit, ready, start and play.
5. Verify result inspection/finalization and claims. Separately test Safety Stop refunds and expired funding.
6. Refresh and sign in through **FUJI CLAIM HISTORY**; verify history and contract-authoritative claims.
7. Between matches, restart the service and check coordinator recovery/history. Never delete the store to bypass a recovery error.

RFC is a nonredeemable test token. This deployment does not include smart accounts, gas sponsorship, voice/AI, moderation or NFT features.

## 5. Operations and troubleshooting

- Disable automatic deploys during live playtests or deploy only between games. Attaching a disk causes stop/start deployments; gameplay is in RAM and WebSockets disconnect on restart. Persistent coordinator records are not durable gameplay-seat recovery. Interrupted matches may need the timeout/refund path.
- Wrong creator/signers: compare the keys' public addresses with the list above; do not log the keys.
- RPC errors or insufficient creator gas: restore connectivity/fund the creator with test AVAX; do not redeploy the contracts or clear state to bypass the error.
- Wallet 403/auth errors: open the exact `PUBLIC_ORIGIN`, check HTTPS and remove trailing slashes from the configured origin. Users should refresh/sign in again after server restarts because auth sessions are in memory.
- Pending transaction: inspect the existing transaction hash and receipt before retrying. Avoid concurrent tabs.
- Built-in limits use socket IPs, not forwarded headers. Behind Render's proxy, users may share a limit; review edge-level abuse protection and load-test before opening broad access.
- Back up the private state directory while the service is stopped and test restoration. Do not expose role seeds/replay evidence through a static route or public backup.

Read [FUJI-OPERATIONS.md](FUJI-OPERATIONS.md) for deployment verification and recovery limitations. Render references: [Node web services](https://render.com/docs/deploy-node-express-app), [disks](https://render.com/docs/disks), [Free limitations](https://render.com/docs/free).
