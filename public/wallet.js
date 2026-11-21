(() => {
  'use strict';

  const FUJI_CHAIN_ID = 43113n;
  const tokenAbi = [
    'function balanceOf(address account) view returns (uint256)',
    'function allowance(address owner, address spender) view returns (uint256)',
    'function mint(address to, uint256 amount)',
    'function approve(address spender, uint256 amount) returns (bool)',
  ];
  const escrowAbi = [
    'function joinAndDeposit(bytes32 matchId, uint256 amount)',
    'function setReady(bytes32 matchId)',
    'function claimPayout(bytes32 matchId) returns (uint256 amount)',
    'function depositedFor(bytes32 matchId, address account) view returns (uint256)',
    'function getMatch(bytes32 matchId) view returns ((uint8 state, uint64 createdAt, uint64 lockAt, uint64 startAt, uint64 inspectionEnds, uint256 stake, bytes32 rulesHash, bytes32 rosterHash, bytes32 roleCommitment, address[4] recipients, uint8 deposited, uint8 ready, uint8 claimed, uint8 outcome, bytes32 resultFingerprint, uint256[4] payouts))',
  ];
  const matchStates = ['NONE', 'FUNDING', 'LOCKED', 'ACTIVE', 'RESULT_PENDING', 'SETTLED', 'REFUNDABLE'];
  let authenticatedWallet = null;
  let identityGeneration = 0;
  let transactionBusy = false;
  const pendingMemory = new Map();

  function pendingKey(config) { return `ragefridge:fuji-pending:${config.escrow.toLowerCase()}`; }
  function pendingTransaction(config) {
    safeConfig(config);
    const key = pendingKey(config);
    let saved;
    try { saved = JSON.parse(window.localStorage?.getItem(key) || 'null'); } catch (_) {}
    const record = saved || pendingMemory.get(key);
    return record && /^0x[0-9a-f]{64}$/i.test(record.hash) ? { ...record } : null;
  }
  function rememberTransaction(config, record) {
    const key = pendingKey(config);
    pendingMemory.set(key, record);
    try { window.localStorage?.setItem(key, JSON.stringify(record)); } catch (_) {
      // The in-memory guard remains active if browser storage is unavailable.
    }
  }
  function forgetTransaction(config, hash) {
    if (pendingTransaction(config)?.hash !== hash) return;
    const key = pendingKey(config);
    pendingMemory.delete(key);
    try { window.localStorage?.removeItem(key); } catch (_) {}
  }

  function ethersApi() {
    if (!window.ethers?.BrowserProvider || !window.ethers?.Contract || !window.ethers?.Interface) {
      throw new Error('The local wallet library did not load. Reload the page before connecting a wallet.');
    }
    return window.ethers;
  }

  function safeConfig(config, chain) {
    if (!config || config.enabled !== true || Number(config.chainId) !== 43113) {
      throw new Error('Fuji wallet rooms are not enabled on this server.');
    }
    if (!window.ethers.isAddress(config.token) || !window.ethers.isAddress(config.escrow)) {
      throw new Error('The server returned invalid Fuji contract addresses.');
    }
    if (chain && !/^0x[0-9a-fA-F]{64}$/.test(String(chain.matchId || ''))) {
      throw new Error('This room does not have a valid on-chain match ID yet.');
    }
    if (chain && (!window.ethers.isAddress(chain.token) || !window.ethers.isAddress(chain.escrow) ||
        chain.token.toLowerCase() !== config.token.toLowerCase() || chain.escrow.toLowerCase() !== config.escrow.toLowerCase())) {
      throw new Error('The room contract addresses do not match the server Fuji configuration.');
    }
    return config;
  }

  async function postJson(path, body) {
    const response = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      cache: 'no-store',
      body: JSON.stringify(body),
    });
    let result;
    try { result = await response.json(); } catch (_) { result = null; }
    if (!response.ok) throw new Error(result?.error || result?.message || `Wallet authentication failed (${response.status}).`);
    return result;
  }

  async function currentWallet(config, expectedAddress, { requestAccess = false } = {}) {
    ethersApi();
    if (!window.ethereum?.request) throw new Error('No injected EOA wallet was found. Install or unlock a Fuji-compatible wallet.');
    const provider = new window.ethers.BrowserProvider(window.ethereum);
    if (requestAccess) await window.ethereum.request({ method: 'eth_requestAccounts' });
    const network = await provider.getNetwork();
    if (network.chainId !== FUJI_CHAIN_ID || Number(config.chainId) !== Number(FUJI_CHAIN_ID)) {
      throw new Error('Switch your wallet to Avalanche Fuji (chain ID 43113), then try again.');
    }
    const signer = await provider.getSigner();
    const address = await signer.getAddress();
    if (expectedAddress && address.toLowerCase() !== expectedAddress.toLowerCase()) {
      throw new Error('The connected wallet changed. Reconnect and authenticate with the wallet that joined this seat.');
    }
    return { provider, signer, address };
  }

  async function authenticate(config) {
    const generation = identityGeneration;
    ethersApi();
    safeConfig(config);
    const { signer, address } = await currentWallet(config, null, { requestAccess: true });
    const challenge = await postJson('/api/wallet/challenge', { address });
    if (typeof challenge?.message !== 'string' || typeof challenge?.challengeId !== 'string' || !challenge.challengeId) {
      throw new Error('The server returned an incomplete wallet challenge.');
    }
    const signature = await signer.signMessage(challenge.message);
    // Recheck after the signature prompt so a wallet/account/chain switch cannot bind a different identity.
    const confirmed = await currentWallet(config, address);
    if (confirmed.address.toLowerCase() !== address.toLowerCase()) throw new Error('Wallet identity changed during authentication. Try again.');
    const session = await postJson('/api/wallet/session', { address, challengeId: challenge.challengeId, signature });
    if (generation !== identityGeneration) throw new Error('Wallet identity changed during authentication. Try again.');
    if (typeof session?.token !== 'string' || !session.token || typeof session.address !== 'string' ||
        session.address.toLowerCase() !== address.toLowerCase()) {
      throw new Error('The server did not confirm the wallet address for this session.');
    }
    authenticatedWallet = { token: session.token, address };
    return { ...authenticatedWallet };
  }

  function parseStake(chain) {
    if (typeof chain?.stake !== 'string' || !/^\d+$/.test(chain.stake)) throw new Error('The room has an invalid test-credit stake.');
    const stake = BigInt(chain.stake);
    if (stake <= 0n) throw new Error('The room stake must be greater than zero.');
    return stake;
  }

  async function inspect(config, chain, expectedAddress) {
    ethersApi();
    safeConfig(config, chain);
    const { provider, address } = await currentWallet(config, expectedAddress);
    const matchId = chain.matchId;
    const token = new window.ethers.Contract(config.token, tokenAbi, provider);
    const escrow = new window.ethers.Contract(config.escrow, escrowAbi, provider);
    const [balance, allowance, match, depositedAmount] = await Promise.all([
      token.balanceOf(address),
      token.allowance(address, config.escrow),
      escrow.getMatch(matchId),
      escrow.depositedFor(matchId, address),
    ]);
    const stake = parseStake(chain);
    const matchStake = BigInt(match.stake);
    if (matchStake !== stake) throw new Error('The on-chain stake does not match this room snapshot. Stop and contact the room host.');
    const recipients = Array.from(match.recipients || []);
    const seatIndex = recipients.findIndex((recipient) => recipient.toLowerCase() === address.toLowerCase());
    const mask = seatIndex >= 0 ? 1n << BigInt(seatIndex) : 0n;
    const deposited = seatIndex >= 0 && (BigInt(match.deposited) & mask) !== 0n;
    const ready = seatIndex >= 0 && (BigInt(match.ready) & mask) !== 0n;
    const claimed = seatIndex >= 0 && (BigInt(match.claimed) & mask) !== 0n;
    return {
      address,
      balance: BigInt(balance),
      allowance: BigInt(allowance),
      stake,
      matchState: matchStates[Number(match.state)] || 'UNKNOWN',
      seatIndex,
      deposited,
      ready,
      claimed,
      depositedAmount: BigInt(depositedAmount),
      inspectionEnds: Number(match.inspectionEnds),
    };
  }

  async function waitForReceipt(provider, hash, onStatus) {
    const deadline = Date.now() + 90_000;
    onStatus?.(`Transaction submitted: ${hash}. Waiting for a Fuji confirmation…`);
    while (Date.now() < deadline) {
      let network;
      let receipt;
      try {
        network = await provider.getNetwork();
        if (network.chainId !== FUJI_CHAIN_ID) return { pending: true, hash, reason: 'Wallet network changed before a receipt was confirmed.' };
        receipt = await provider.getTransactionReceipt(hash);
      } catch (_) {
        return { pending: true, hash, reason: 'Receipt lookup failed after submission. Check this transaction before retrying.' };
      }
      if (receipt) {
        if (Number(receipt.status) !== 1) throw Object.assign(new Error('The Fuji transaction reverted. No action was completed.'), { txHash: hash });
        return { pending: false, hash, receipt };
      }
      onStatus?.(`Transaction submitted: ${hash}. Still waiting for a Fuji confirmation…`);
      await new Promise((resolve) => window.setTimeout(resolve, 2_000));
    }
    return { pending: true, hash, reason: 'Receipt confirmation timed out. Do not resubmit until the transaction is checked.' };
  }

  async function transact(action, config, chain, expectedAddress, onStatus) {
    if (transactionBusy) throw new Error('A wallet transaction is already being processed.');
    transactionBusy = true;
    try {
      const pending = pendingTransaction(config);
      if (pending) {
        const checked = await receipt(config, pending.hash);
        if (checked.pending) throw new Error(`A Fuji transaction is still pending: ${pending.hash}. Check it before retrying.`);
      }
      return await transactImpl(action, config, chain, expectedAddress, onStatus);
    } finally { transactionBusy = false; }
  }

  async function transactImpl(action, config, chain, expectedAddress, onStatus) {
    ethersApi();
    safeConfig(config, chain);
    const progress = await inspect(config, chain, expectedAddress);
    if (progress.seatIndex < 0) throw new Error('This wallet is not a recipient for the on-chain match. No transaction was sent.');
    const { provider, signer, address } = await currentWallet(config, expectedAddress);
    const token = new window.ethers.Contract(config.token, tokenAbi, signer);
    const escrow = new window.ethers.Contract(config.escrow, escrowAbi, signer);
    const matchId = chain.matchId;
    const stake = progress.stake;
    let target;

    if (action === 'mint') {
      if (progress.matchState !== 'FUNDING' || progress.balance >= stake) throw new Error('Your current Fuji credit balance does not need this mint. Refresh room status.');
      target = await token.mint(address, stake);
    } else if (action === 'approve') {
      if (progress.matchState !== 'FUNDING' || progress.deposited || progress.balance < stake || progress.allowance === stake) {
        throw new Error('Exact-stake approval is not currently needed. Refresh room status.');
      }
      // The escrow requires an exact one-use allowance; never request an unlimited approval.
      target = await token.approve(config.escrow, stake);
    } else if (action === 'deposit') {
      if (progress.matchState !== 'FUNDING' || progress.deposited || progress.allowance !== stake || progress.balance < stake) {
        throw new Error('Deposit requires the exact stake allowance and an unfilled seat. Refresh room status.');
      }
      target = await escrow.joinAndDeposit(matchId, stake);
    } else if (action === 'ready') {
      if (progress.matchState !== 'FUNDING' || !progress.deposited || progress.ready) throw new Error('Deposit must be confirmed before marking ready. Refresh room status.');
      target = await escrow.setReady(matchId);
    } else if (action === 'claim') {
      if (!['SETTLED', 'REFUNDABLE'].includes(progress.matchState) || progress.claimed) throw new Error('There is no unclaimed payout or refund for this wallet.');
      target = await escrow.claimPayout(matchId);
    } else {
      throw new Error('Unknown wallet action.');
    }

    if (!target?.hash) throw new Error('The wallet did not return a transaction hash.');
    rememberTransaction(config, { hash: target.hash, action, matchId, address });
    let network;
    try { network = await provider.getNetwork(); } catch (_) {
      return { pending: true, hash: target.hash, reason: 'Network lookup failed after submission. Check this transaction before retrying.' };
    }
    if (network.chainId !== FUJI_CHAIN_ID) return { pending: true, hash: target.hash, reason: 'Wallet network changed while the transaction was being submitted. Check Fuji before continuing.' };
    let result;
    try { result = await waitForReceipt(provider, target.hash, onStatus); }
    catch (error) {
      if (error.txHash === target.hash) forgetTransaction(config, target.hash);
      throw error;
    }
    if (!result.pending) {
      forgetTransaction(config, target.hash);
      const after = await currentWallet(config, expectedAddress);
      if (after.address.toLowerCase() !== address.toLowerCase()) throw new Error('The transaction confirmed, but the wallet identity changed. Reconnect before another action.');
    }
    return result;
  }

  async function receipt(config, hash) {
    ethersApi();
    safeConfig(config);
    if (!/^0x[0-9a-f]{64}$/i.test(hash)) throw new Error('Invalid transaction hash.');
    const { provider } = await currentWallet(config, null);
    const network = await provider.getNetwork();
    if (network.chainId !== FUJI_CHAIN_ID) return { pending: true };
    const result = await provider.getTransactionReceipt(hash);
    if (!result) return { pending: true };
    forgetTransaction(config, hash);
    return { pending: false, success: Number(result.status) === 1 };
  }

  async function watch(config, hash, expectedAddress, onStatus) {
    ethersApi();
    safeConfig(config);
    const { provider } = await currentWallet(config, expectedAddress);
    return waitForReceipt(provider, hash, onStatus);
  }

  function clearAuthentication() { authenticatedWallet = null; }

  function onWalletIdentityChanged(reason) {
    identityGeneration++;
    if (authenticatedWallet) authenticatedWallet = null;
    window.dispatchEvent(new CustomEvent('ragewallet:invalidated', { detail: { reason } }));
  }

  if (window.ethereum?.on) {
    window.ethereum.on('accountsChanged', () => onWalletIdentityChanged('Wallet account changed. The current wallet binding was invalidated.'));
    window.ethereum.on('chainChanged', () => onWalletIdentityChanged('Wallet network changed. The current wallet binding was invalidated.'));
  }

  window.RageFridgeWallet = Object.freeze({ authenticate, inspect, transact, receipt, watch, clearAuthentication, safeConfig, pendingTransaction });
})();
