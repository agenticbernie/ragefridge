import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { Game, BOT_NAMES, ROLES } from './game.js';

const root = fileURLToPath(new URL('../public/', import.meta.url));
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml' };
const MAX_WS_PAYLOAD = 8 * 1024;
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
  const file = normalize(join(root, requested));
  if (!file.startsWith(root)) {
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

export function createServer({ port = 0, now = () => Date.now(), completedRoomRetentionMs = COMPLETED_ROOM_RETENTION_MS } = {}) {
  // Every server owns its own registries. This permits independent test and production instances.
  const rooms = new Map();
  const clients = new Map();
  const sessionTokens = new WeakMap();
  const seatSockets = new WeakMap();
  const roomLifecycle = new WeakMap();
  const clock = typeof now === 'function' ? now : () => Date.now();

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
    const game = new Game(code, message.demo === true);
    const player = game.addPlayer(randomUUID(), safeName(message.name), false);
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
    const player = game.addPlayer(randomUUID(), safeName(message.name), false);
    if (!player) return error(socket, game.phase === 'lobby' ? 'This room is full.' : 'This match has already started.');
    bindNewPlayer(socket, game, player);
    roomStates(game);
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
    if (!game || game.phase === 'lobby' || !player || player.bot || player.connected || binding ||
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
    game.finish('void', 'safetyStop');
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
    if (game.phase === 'lobby' || revokeSession) sessionTokens.get(game)?.delete(id);
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

  function handleMessage(socket, raw) {
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
    if (message.type === 'create') return createRoom(socket, message);
    if (message.type === 'join') return joinRoom(socket, message);
    if (message.type === 'resume') return resumeRoom(socket, message);
    if (message.type === 'leave') return leaveRoom(socket);
    const client = clients.get(socket);
    if (!client?.game) return error(socket, 'Create or join a room first.');
    const { game, id } = client;
    let failure = null;
    if (message.type === 'start') failure = game.start(id, shuffleRoles());
    else if (message.type === 'action') failure = game.submit(id, message);
    else if (message.type === 'stop') return stopRoom(socket);
    if (failure) error(socket, failure);
    markLifecycle(game);
    roomStates(game);
    return game;
  }

  const httpServer = http.createServer((request, response) => {
    if (request.url === '/healthz') {
      response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ ok: true, rooms: rooms.size }));
    } else serveStatic(request, response);
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
    wss.handleUpgrade(request, socket, head, (ws) => wss.emit('connection', ws, request));
  });
  wss.on('connection', (socket) => {
    socket.on('message', (raw) => handleMessage(socket, raw));
    socket.on('close', () => { unbindSocket(socket); });
    socket.on('error', () => {});
  });
  const timer = setInterval(() => {
    const current = clock();
    for (const game of [...rooms.values()]) {
      if (game.phase !== 'lobby' && game.phase !== 'ended') {
        game.tick(current);
        roomStates(game);
      }
      markLifecycle(game, current);
    }
    cleanupRooms(current);
  }, 1000);
  timer.unref();
  return { httpServer, wss, rooms, clients, cleanupRooms, close: () => new Promise((resolve) => {
    clearInterval(timer);
    for (const socket of wss.clients) socket.terminate();
    wss.close();
    httpServer.close(resolve);
  }), listen: () => new Promise((resolve) => httpServer.listen(port, resolve)) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const server = createServer({ port: Number(process.env.PORT) || 3000 });
  await server.listen();
  const address = server.httpServer.address();
  console.log(`RageFridge server listening on http://localhost:${address.port}`);
}
