import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { Game, BOT_NAMES, ROLES } from './game.js';
import { createWalletAuth } from './wallet-auth.js';
import { createChainCoordinator } from './chain.js';
import { createRateLimit } from './rate-limit.js';

const root = fileURLToPath(new URL('../public/', import.meta.url));
const ethersBundle = fileURLToPath(new URL('../node_modules/ethers/dist/ethers.umd.min.js', import.meta.url));
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml' };
const MAX_WS_PAYLOAD = 8 * 1024;
const MAX_HTTP_PAYLOAD = 4 * 1024;
const COMPLETED_ROOM_RETENTION_MS = 15 * 60 * 1000;
const MESSAGE_TYPES = new Set(['create', 'join', 'resume', 'start', 'action', 'stop', 'leave']);

export function makeCode() {
  return randomBytes(3).toString('hex').toUpperCase();
}

// Copy before shuffling so the authored roster remains immutable across matches.
export function shuffleRoles() {
  const roles = ROLES.slice();
  for (let index = roles.length - 1; index > 0; index--) {
    const target = randomInt(index + 1);
    [roles[index], roles[target]] = [roles[target], roles[index]];
  }
  return roles;
}

function safeName(value) {
  const name = typeof value === 'string' ? value.trim().replace(/[\u0000-\u001f]/g, '').slice(0, 32) : '';
  return name || 'Guest';
}

function send(socket, message) {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
}

function error(socket, message) {
  send(socket, { type: 'error', message });
}

function validSessionToken(value, expected) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value) || !Buffer.isBuffer(expected)) return false;
  let supplied;
  try {
    supplied = Buffer.from(value, 'base64url');
  } catch {
    return false;
  }
  // Base64url has multiple textual aliases for an incomplete final quantum; accept only canonical encodings.
  return supplied.length === expected.length && value === supplied.toString('base64url') && timingSafeEqual(supplied, expected);
}

async function serveStatic(request, response) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
  } catch {
    response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Bad path');
    return;
  }
  const requested = pathname === '/' ? 'index.html' : pathname.slice(1);
  const file = requested === 'vendor/ethers.umd.min.js' ? ethersBundle : normalize(join(root, requested));
  if (file !== ethersBundle && !file.startsWith(root)) {
    response.writeHead(400); response.end('Bad path'); return;
  }
  try {
    const body = await readFile(file);
    response.writeHead(200, { 'Content-Type': mime[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' });
    response.end(body);
  } catch {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Not found');
  }
}

async function readJson(request) {
  if (!request.headers['content-type']?.toLowerCase().startsWith('application/json')) {
    throw new Error('Expected JSON.');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_HTTP_PAYLOAD) throw new Error('Request too large.');
    chunks.push(chunk);
  }
  const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error('Expected JSON object.');
  return value;
}

export function createServer({ port = 0, now = () => Date.now(), completedRoomRetentionMs = COMPLETED_ROOM_RETENTION_MS,
  chain = null, publicOrigin = process.env.PUBLIC_ORIGIN, roomAttemptsPerMinute = 60,
  maxRooms = 1_000, maxConnections = 512, maxConnectionsPerIp = 32 } = {}) {
  // Every server owns its own registries. This permits independent test and production instances.
  const rooms = new Map();
  const clients = new Map();
  const sessionTokens = new WeakMap();
  const seatSockets = new WeakMap();
  const roomLifecycle = new WeakMap();
  const clock = typeof now === 'function' ? now : () => Date.now();
  const roomAttemptAllowed = createRateLimit({ limit: roomAttemptsPerMinute, windowMs: 60_000, now: clock });
  const socketAddresses = new WeakMap();
  const walletAuth = createWalletAuth({ origin: publicOrigin, now: clock });
  const paidRooms = new WeakSet();
  const settlingGames = new WeakSet();
  const settlementRetryAt = new WeakMap();
  const settlementAttempts = new WeakMap();

  function attachWallet(message, game) {
    const wallet = walletAuth.address(message.authToken);
    if (game?.paid && !wallet) throw new Error('Sign in with the wallet that owns this seat.');
    if (message.paid === true && (!chain?.publicConfig().enabled || !wallet)) {
      throw new Error('Fuji wallet rooms are unavailable or the wallet is not signed in.');
    }
    if ((message.paid === true || game?.paid) && chain.isAllowedPlayer && !chain.isAllowedPlayer(wallet)) {
      throw new Error('This wallet is not allowlisted for the Fuji test.');
    }
    return wallet;
  }

  function preparePaidRoom(game) {
    if (!game?.paid || game.players.length !== 4 || paidRooms.has(game)) return;
    paidRooms.add(game);
    game.starting = true;
    game.chain = { state: 'CREATING', stake: chain.publicConfig().stake,
      token: chain.publicConfig().token, escrow: chain.publicConfig().escrow };
    Promise.resolve(chain.prepare(game)).then((status) => {
      game.chain = status;
      game.starting = false;
      roomStates(game);
    }).catch(() => {
      game.chain = { ...game.chain, state: 'ERROR', error: 'Unable to prepare Fuji escrow. Ask the host to create a new room.' };
      game.starting = false;
      roomStates(game);
    });
  }

  function state(socket, game) {
    const client = clients.get(socket);
    if (client?.game === game && client.id && game.getPlayer(client.id)) {
      send(socket, { type: 'state', state: game.snapshot(client.id) });
    }
  }

  function roomStates(game) {
    if (!game) return;
    for (const [socket, client] of clients) if (client.game === game) state(socket, game);
  }

  function completePaidGame(game) {
    if (!game?.paid || game.phase !== 'ended' || settlingGames.has(game) || clock() < (settlementRetryAt.get(game) ?? 0)) return;
    settlingGames.add(game);
    Promise.resolve(chain.complete(game)).then(() => {
      settlementAttempts.delete(game);
      settlementRetryAt.delete(game);
    }).catch(() => {
      const attempts = (settlementAttempts.get(game) ?? 0) + 1;
      settlementAttempts.set(game, attempts);
      settlementRetryAt.set(game, clock() + Math.min(60_000, 1_000 * (2 ** Math.min(attempts, 6))));
    }).finally(() => settlingGames.delete(game));
  }

  function addDemo(game) {
    for (const name of BOT_NAMES) game.addPlayer(`bot-${randomUUID()}`, name, true);
  }

  function lifecycle(game) {
    return roomLifecycle.get(game);
  }

  function hasBoundClient(game) {
    for (const client of clients.values()) if (client.game === game) return true;
    return false;
  }

  function markLifecycle(game, current = clock()) {
    const details = lifecycle(game);
    if (!details || game.phase !== 'ended') return;
    details.finishedAt ??= current;
    // Preserve results for connected viewers; retention begins only after the final human disconnects.
    details.inactiveAt = hasBoundClient(game) ? null : (details.inactiveAt ?? current);
  }

  function hasHumanSeat(game) {
    return game.players.some((player) => !player.bot);
  }

  function purgeRoom(game) {
    if (rooms.get(game.code) !== game) return;
    rooms.delete(game.code);
    const bindings = seatSockets.get(game);
    for (const [socket, client] of clients) {
      if (client.game !== game) continue;
      if (bindings?.get(client.id) === socket) bindings.delete(client.id);
      clients.delete(socket);
      // A room that aged out is no longer bound to this socket; it may create or join again.
      send(socket, { type: 'left' });
    }
  }

  function purgeEmptyLobby(game) {
    if (game.phase === 'lobby' && !hasHumanSeat(game)) purgeRoom(game);
  }

  function cleanupRooms(current = clock()) {
    for (const game of [...rooms.values()]) {
      markLifecycle(game, current);
      purgeEmptyLobby(game);
      const details = lifecycle(game);
      // Never expire a match still in progress: disconnect grace and game rules remain authoritative.
      if (rooms.get(game.code) === game && game.phase === 'ended' &&
          details?.finishedAt != null && details.inactiveAt != null && current - details.inactiveAt >= completedRoomRetentionMs) {
        purgeRoom(game);
      }
    }
  }

  function sendSession(socket, game, id, token) {
    // This frame is deliberately private and is never derived from game snapshots or events.
    send(socket, { type: 'session', code: game.code, id, token: token.toString('base64url') });
  }

  function bindNewPlayer(socket, game, player) {
    const token = randomBytes(32);
    sessionTokens.get(game).set(player.id, token);
    seatSockets.get(game).set(player.id, socket);
    clients.set(socket, { id: player.id, game });
    sendSession(socket, game, player.id, token);
    state(socket, game);
  }

  function createRoom(socket, message) {
    if (clients.get(socket)?.game) return error(socket, 'You are already in a room.');
    let code;
    do { code = makeCode(); } while (rooms.has(code));
    let wallet;
    try { wallet = attachWallet(message); } catch (e) { return error(socket, e.message); }
    if (message.paid === true && message.demo === true) return error(socket, 'Bot demo cannot use a wallet room.');
    const game = new Game(code, message.demo === true);
    game.paid = message.paid === true;
    if (game.paid) {
      const config = chain.publicConfig();
      game.chain = { state: 'WAITING_FOR_PLAYERS', stake: config.stake,
        token: config.token, escrow: config.escrow };
    }
    const player = game.addPlayer(randomUUID(), safeName(message.name), false);
    player.wallet = wallet;
    if (game.demo) addDemo(game);
    rooms.set(game.code, game);
    sessionTokens.set(game, new Map());
    seatSockets.set(game, new Map());
    roomLifecycle.set(game, { finishedAt: null, inactiveAt: null });
    bindNewPlayer(socket, game, player);
    return game;
  }

  function joinRoom(socket, message) {
    if (clients.get(socket)?.game) return error(socket, 'You are already in a room.');
    const code = typeof message.code === 'string' ? message.code.trim().toUpperCase() : '';
    const game = rooms.get(code);
    if (!game) return error(socket, 'Room not found. Check the code and try again.');
    let wallet;
    try { wallet = attachWallet(message, game); } catch (e) { return error(socket, e.message); }
    if (game.paid && game.players.some((seat) => seat.wallet?.toLowerCase() === wallet.toLowerCase())) {
      return error(socket, 'This wallet already occupies a seat in this room.');
    }
    const player = game.addPlayer(randomUUID(), safeName(message.name), false);
    if (!player) return error(socket, game.phase === 'lobby' ? 'This room is full.' : 'This match has already started.');
    player.wallet = wallet;
    bindNewPlayer(socket, game, player);
    roomStates(game);
    preparePaidRoom(game);
    return game;
  }

  function resumeRoom(socket, message) {
    if (clients.get(socket)?.game) return error(socket, 'You are already in a room.');
    const code = typeof message.code === 'string' ? message.code.trim().toUpperCase() : '';
    const id = typeof message.id === 'string' ? message.id : '';
    const game = rooms.get(code);
    const player = game?.getPlayer(id);
    const token = game ? sessionTokens.get(game)?.get(id) : undefined;
    const binding = game ? seatSockets.get(game)?.get(id) : undefined;
    if (!game || (game.phase === 'lobby' && !game.paid) || !player || player.bot || player.connected || binding ||
        !validSessionToken(message.token, token)) {
      return error(socket, 'Unable to resume this session.');
    }
    if (!game.reconnect(id, clock())) return error(socket, 'Unable to resume this session.');
    const replacement = randomBytes(32);
    sessionTokens.get(game).set(id, replacement);
    seatSockets.get(game).set(id, socket);
    clients.set(socket, { id, game });
    markLifecycle(game);
    sendSession(socket, game, id, replacement);
    roomStates(game);
    return game;
  }

  function stopRoom(socket) {
    const client = clients.get(socket);
    if (!client?.game) return error(socket, 'Join a room before stopping it.');
    const game = client.game;
    if (game.phase === 'lobby' || game.phase === 'ended') return error(socket, 'There is no active match to stop.');
    game.audit?.inputs.push({ type: 'stop' });
    game.finish('void', 'safetyStop');
    completePaidGame(game);
    markLifecycle(game);
    roomStates(game);
  }

  function unbindSocket(socket, { revokeSession = false } = {}) {
    const client = clients.get(socket);
    if (!client) return null;
    const { game, id } = client;
    clients.delete(socket);
    const bindings = seatSockets.get(game);
    // A stale socket must never disconnect a player already rebound to a newer connection.
    if (bindings?.get(id) !== socket) return game;
    bindings.delete(id);
    game.disconnect(id, clock());
    if ((game.phase === 'lobby' && !game.paid) || revokeSession) sessionTokens.get(game)?.delete(id);
    markLifecycle(game);
    purgeEmptyLobby(game);
    if (rooms.get(game.code) === game) roomStates(game);
    return game;
  }

  function leaveRoom(socket) {
    if (!clients.get(socket)?.game) return error(socket, 'Create or join a room first.');
    unbindSocket(socket, { revokeSession: true });
    send(socket, { type: 'left' });
  }

  async function handleMessage(socket, raw) {
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      return error(socket, 'Messages must be valid JSON.');
    }
    if (!message || Array.isArray(message) || typeof message.type !== 'string') {
      return error(socket, 'Message type is required.');
    }
    if (!MESSAGE_TYPES.has(message.type)) return error(socket, 'Unknown message type.');
    if (message.type === 'create' || message.type === 'join') {
      if (!roomAttemptAllowed(socketAddresses.get(socket))) return error(socket, 'Room request rate limit exceeded. Wait a minute before retrying.');
      if (message.type === 'create' && rooms.size >= maxRooms) return error(socket, 'The kitchen is at capacity. Try again later.');
    }
    if (message.type === 'create') return createRoom(socket, message);
    if (message.type === 'join') return joinRoom(socket, message);
    if (message.type === 'resume') return resumeRoom(socket, message);
    if (message.type === 'leave') return leaveRoom(socket);
    const client = clients.get(socket);
    if (!client?.game) return error(socket, 'Create or join a room first.');
    const { game, id } = client;
    let failure = null;
    if (message.type === 'start') {
      if (id !== game.hostId) failure = 'Only the host can start the match.';
      else if (!game.canStart()) failure = 'The lobby needs four connected seats before it can start.';
      else if (game.paid) {
        if (game.starting) return error(socket, 'The match start transaction is already being processed.');
        game.starting = true;
        try {
          const roles = await chain.start(game);
          failure = game.start(id, roles);
        } catch {
          failure = 'Fuji escrow is not locked yet. Confirm all four deposits and ready transactions.';
        } finally {
          game.starting = false;
        }
      } else failure = game.start(id, shuffleRoles());
    }
    else if (message.type === 'action') failure = game.submit(id, message);
    else if (message.type === 'stop') return stopRoom(socket);
    if (failure) error(socket, failure);
    markLifecycle(game);
    roomStates(game);
    return game;
  }

  const httpServer = http.createServer({ requestTimeout: 15_000, headersTimeout: 10_000, keepAliveTimeout: 5_000 }, async (request, response) => {
    response.setHeader('Content-Security-Policy', "default-src 'self'; base-uri 'self'; frame-ancestors 'none'; object-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com data:; img-src 'self' data:; connect-src 'self' ws: wss:");
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    if (request.url === '/healthz') {
      response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ ok: true, rooms: rooms.size }));
      return;
    }
    let url;
    try {
      url = new URL(request.url, 'http://localhost');
    } catch {
      response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Bad URL');
      return;
    }
    if (url.pathname === '/api/chain/config' && request.method === 'GET') {
      response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      response.end(JSON.stringify(chain?.publicConfig() ?? { enabled: false, chainId: 43113 }));
      return;
    }
    if (url.pathname.startsWith('/api/wallet/') && !walletAuth.allowedOrigin(request)) {
      response.writeHead(403); response.end('Forbidden origin'); return;
    }
    if (url.pathname.startsWith('/api/wallet/') && !walletAuth.rateLimit(request.socket.remoteAddress ?? 'unknown')) {
      response.writeHead(429); response.end('Rate limit exceeded'); return;
    }
    if (url.pathname === '/api/wallet/matches' && request.method === 'GET') {
      const bearer = request.headers.authorization?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1];
      const address = walletAuth.address(bearer);
      if (!address) { response.writeHead(401); response.end('Wallet sign-in required'); return; }
      const rawOffset = url.searchParams.get('offset') ?? '0';
      if (!/^\d{1,9}$/.test(rawOffset)) { response.writeHead(400); response.end('Invalid offset'); return; }
      response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      response.end(JSON.stringify(chain?.listMatches?.(address, Number(rawOffset)) ?? { matches: [], nextOffset: null }));
      return;
    }
    if (url.pathname === '/api/wallet/challenge' && request.method === 'POST') {
      try {
        const body = await readJson(request);
        const result = walletAuth.challenge(body.address, request.headers.origin);
        response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        response.end(JSON.stringify(result));
      } catch {
        response.writeHead(400); response.end('Invalid wallet address');
      }
      return;
    }
    if (url.pathname === '/api/wallet/session' && request.method === 'POST') {
      try {
        const result = walletAuth.login(await readJson(request));
        response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        response.end(JSON.stringify(result));
      } catch {
        response.writeHead(401); response.end('Invalid or expired wallet login');
      }
      return;
    }
    if (url.pathname.startsWith('/api/')) {
      response.writeHead(404); response.end('Not found'); return;
    }
    serveStatic(request, response);
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_WS_PAYLOAD });
  httpServer.on('upgrade', (request, socket, head) => {
    let pathname;
    try {
      pathname = new URL(request.url, 'http://localhost').pathname;
    } catch {
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    if (pathname !== '/ws') return socket.destroy();
    if (request.headers.origin && !walletAuth.allowedOrigin(request)) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    const address = request.socket.remoteAddress ?? 'unknown';
    const sameAddress = [...wss.clients].filter((client) => socketAddresses.get(client) === address).length;
    if (wss.clients.size >= maxConnections || sameAddress >= maxConnectionsPerIp) {
      socket.write('HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => wss.emit('connection', ws, request));
  });
  wss.on('connection', (socket, request) => {
    socketAddresses.set(socket, request.socket.remoteAddress ?? 'unknown');
    let messageWindow = clock();
    let messageCount = 0;
    socket.isAlive = true;
    socket.on('pong', () => { socket.isAlive = true; });
    socket.on('message', (raw) => {
      if (clock() - messageWindow >= 10_000) { messageWindow = clock(); messageCount = 0; }
      if (++messageCount > 60) { socket.close(1008, 'Message rate limit exceeded'); return; }
      void handleMessage(socket, raw).catch(() => error(socket, 'Request failed.'));
    });
    socket.on('close', () => { unbindSocket(socket); });
    socket.on('error', () => {});
  });
  const timer = setInterval(() => {
    const current = clock();
    for (const game of [...rooms.values()]) {
      if (game.phase !== 'lobby' && game.phase !== 'ended') {
        game.tick(current);
        roomStates(game);
        if (game.phase === 'ended' && game.paid) completePaidGame(game);
      }
      markLifecycle(game, current);
    }
    cleanupRooms(current);
  }, 1000);
  timer.unref();
  const heartbeat = setInterval(() => {
    for (const socket of wss.clients) {
      if (socket.readyState !== socket.OPEN) continue;
      if (!socket.isAlive) { socket.terminate(); continue; }
      socket.isAlive = false;
      socket.ping();
    }
  }, 30_000);
  heartbeat.unref();
  const chainTimer = chain ? setInterval(() => {
    void chain.tick().then(() => {
      for (const game of rooms.values()) {
        if (!game.paid) continue;
        if (game.phase === 'ended') completePaidGame(game);
        roomStates(game);
      }
    }).catch(() => {});
  }, 5000) : null;
  chainTimer?.unref();
  return { httpServer, wss, rooms, clients, cleanupRooms, close: () => new Promise((resolve) => {
    clearInterval(timer);
    clearInterval(heartbeat);
    if (chainTimer) clearInterval(chainTimer);
    for (const socket of wss.clients) socket.terminate();
    wss.close();
    httpServer.close(async () => {
      try { await chain?.close?.(); } catch { /* shutdown must not hang on provider cleanup */ }
      resolve();
    });
  }), listen: () => new Promise((resolve) => httpServer.listen(port, resolve)) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const chain = await createChainCoordinator();
  const server = createServer({ port: Number(process.env.PORT) || 10000, chain });
  await server.listen();
  const address = server.httpServer.address();
  console.log(`RageFridge server listening on http://localhost:${address.port}`);
  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    void server.close().catch(() => { process.exitCode = 1; });
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}
