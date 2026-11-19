import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import WebSocket from 'ws';
import { createServer, shuffleRoles } from '../server/index.js';
import { ROLES } from '../server/game.js';

let server;
let base;

test.before(async () => {
  server = createServer({ port: 0 });
  await server.listen();
  const { port } = server.httpServer.address();
  base = `http://127.0.0.1:${port}`;
});

test.after(async () => {
  await server.close();
});

function connect(origin = base) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`${origin.replace('http', 'ws')}/ws`);
    const rejectOpen = (error) => { socket.off('open', resolve); reject(error); };
    socket.once('open', () => { socket.off('error', rejectOpen); resolve(socket); });
    socket.once('error', rejectOpen);
  });
}

function next(socket, predicate = () => true, timeout = 2000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(reject, new Error('Timed out waiting for WebSocket message.')), timeout);
    const finish = (done, value) => {
      clearTimeout(timer);
      socket.off('message', onMessage);
      socket.off('error', onError);
      socket.off('close', onClose);
      done(value);
    };
    const onMessage = (raw) => {
      let message;
      try { message = JSON.parse(raw); } catch (error) { finish(reject, error); return; }
      if (predicate(message)) finish(resolve, message);
    };
    const onError = (error) => finish(reject, error);
    const onClose = (code) => finish(reject, new Error(`Socket closed before a message (code ${code}).`));
    socket.on('message', onMessage);
    socket.once('error', onError);
    socket.once('close', onClose);
  });
}

function send(socket, message) { socket.send(JSON.stringify(message)); }

function nonCanonicalTokenAlias(token) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const index = alphabet.indexOf(token.at(-1));
  return `${token.slice(0, -1)}${alphabet[(index & 0b111100) | ((index + 1) & 0b11)]}`;
}

async function close(socket) {
  if (socket.readyState === WebSocket.CLOSED) return;
  const closed = once(socket, 'close');
  socket.close();
  await closed;
}

async function closeAll(sockets) {
  await Promise.all(sockets.map((socket) => close(socket)));
}

function request(pathname) {
  const { port } = new URL(base);
  return new Promise((resolve, reject) => {
    const request = http.request({ hostname: '127.0.0.1', port, path: pathname }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    request.once('error', reject);
    request.end();
  });
}

function rawHttpRequest(target, upgrade = false) {
  const { port } = new URL(base);
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    let response = '';
    const finish = (done, value) => {
      socket.removeAllListeners();
      done(value);
    };
    socket.setEncoding('utf8');
    socket.setTimeout(2000);
    socket.once('connect', () => {
      const headers = upgrade
        ? ['Connection: Upgrade', 'Upgrade: websocket', 'Sec-WebSocket-Version: 13', 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==']
        : ['Connection: close'];
      socket.write(`GET ${target} HTTP/1.1\r\nHost: 127.0.0.1\r\n${headers.join('\r\n')}\r\n\r\n`);
    });
    socket.on('data', (chunk) => { response += chunk; });
    socket.once('timeout', () => {
      socket.destroy();
      finish(reject, new Error('Timed out waiting for raw HTTP response.'));
    });
    socket.once('error', (error) => finish(reject, error));
    socket.once('close', () => finish(resolve, response));
  });
}

async function createStartedRoom() {
  const sockets = await Promise.all([connect(), connect(), connect(), connect()]);
  const sessions = sockets.map((socket) => next(socket, (message) => message.type === 'session'));
  const hostState = next(sockets[0], (message) => message.type === 'state');
  send(sockets[0], { type: 'create', name: 'Host' });
  const initial = await hostState;
  const code = initial.state.code;
  for (let index = 1; index < sockets.length; index++) {
    const joined = next(sockets[index], (message) => message.type === 'state');
    send(sockets[index], { type: 'join', name: `Player ${index}`, code });
    await joined;
  }
  const denied = next(sockets[1], (message) => message.type === 'error');
  send(sockets[1], { type: 'start' });
  assert.match((await denied).message, /host/);
  const started = sockets.map((socket) => next(socket, (message) => message.type === 'state' && message.state.phase === 'roles'));
  send(sockets[0], { type: 'start' });
  await Promise.all(started);
  return { sockets, code, sessions: await Promise.all(sessions), game: server.rooms.get(code) };
}

async function stopRoom(sockets) {
  const ended = sockets.map((socket) => next(socket, (message) => message.type === 'state' && message.state.phase === 'ended'));
  send(sockets[0], { type: 'stop' });
  await Promise.all(ended);
}

test('health endpoint, malformed static path, and websocket handshake keep the server alive', async () => {
  assert.equal((await request('/%')).status, 400);
  assert.match(await rawHttpRequest('http://%', true), /^HTTP\/1\.1 400 /);
  assert.match(await rawHttpRequest('http://%'), /^HTTP\/1\.1 400 /);
  const response = await fetch(`${base}/healthz`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, rooms: 0 });
  const socket = await connect();
  await close(socket);
});

test('demo create fills four seats with clearly labeled bots and sends a private session', async () => {
  const socket = await connect();
  const session = next(socket, (message) => message.type === 'session');
  const state = next(socket, (message) => message.type === 'state');
  send(socket, { type: 'create', name: 'Host', demo: true });
  const [credentials, message] = await Promise.all([session, state]);
  assert.match(credentials.token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(credentials.code, message.state.code);
  assert.equal(credentials.id, message.state.you.id);
  assert.equal(message.state.mode, 'demo');
  assert.equal(message.state.players.length, 4);
  assert.equal(message.state.players.filter((player) => player.bot).length, 3);
  assert.ok(message.state.players.filter((player) => player.bot).every((player) => /\(Bot\)$/.test(player.name)));
  assert.equal(message.state.you.id, message.state.players.find((player) => !player.bot).id);
  assert.doesNotMatch(JSON.stringify(message), /token/);
  await close(socket);
});

test('four-person room broadcasts state, enforces host start, and preserves the role roster', async () => {
  const { sockets, game } = await createStartedRoom();
  assert.equal(game.phase, 'roles');
  assert.deepEqual(game.players.map((player) => player.role).sort(), ROLES.slice().sort());
  await stopRoom(sockets);
  await closeAll(sockets);
});

test('Fisher-Yates role shuffle preserves the authored roster without mutating it', () => {
  const roster = ROLES.slice().sort();
  for (let attempt = 0; attempt < 50; attempt++) assert.deepEqual(shuffleRoles().sort(), roster);
  assert.deepEqual(ROLES.slice().sort(), roster);
});

test('action contract returns errors and state includes authoritative fields', async () => {
  const socket = await connect();
  const session = next(socket, (message) => message.type === 'session');
  const create = next(socket, (message) => message.type === 'state');
  send(socket, { type: 'create', name: 'Host' });
  const [credentials, initial] = await Promise.all([session, create]);
  const noRoomAction = await (async () => {
    const other = await connect();
    const failure = next(other, (message) => message.type === 'error');
    send(other, { type: 'action', action: 'roast' });
    const result = await failure;
    await close(other);
    return result;
  })();
  assert.match(noRoomAction.message, /room/);
  assert.equal(initial.state.phase, 'lobby');
  assert.ok('temperature' in initial.state && 'remaining' in initial.state && 'coldHold' in initial.state);
  assert.ok(Array.isArray(initial.state.events));
  assert.doesNotMatch(JSON.stringify(initial.state), new RegExp(credentials.token));
  await close(socket);
});

test('malformed message types and an oversized payload are rejected without taking down the server', async () => {
  const socket = await connect();
  const typeMissing = next(socket, (message) => message.type === 'error');
  socket.send('[]');
  assert.match((await typeMissing).message, /type/);
  const unknown = next(socket, (message) => message.type === 'error');
  send(socket, { type: 'not-a-real-message' });
  assert.match((await unknown).message, /Unknown/);
  const created = next(socket, (message) => message.type === 'state');
  send(socket, { type: 'create', name: 'Still Alive' });
  await created;
  await close(socket);

  const oversized = await connect();
  const closed = once(oversized, 'close');
  oversized.send(JSON.stringify({ type: 'create', name: 'X', padding: 'x'.repeat(9 * 1024) }));
  const [code] = await closed;
  assert.equal(code, 1009);
  const response = await fetch(`${base}/healthz`);
  assert.equal(response.status, 200);
});

test('resume requires the private token, rotates it, and restores the existing player state', async () => {
  const { sockets, code, sessions, game } = await createStartedRoom();
  const hostSession = sessions[0];
  const player = game.getPlayer(hostSession.id);
  const before = { role: player.role, bp: player.bp, scoredReady: player.scoredReady, restReady: player.restReady };
  await close(sockets[0]);
  assert.equal(player.connected, false);

  const invalidAttempts = [
    { code: 'FFFFFF', id: hostSession.id, token: hostSession.token },
    { code, id: 'not-a-seat', token: hostSession.token },
    { code, id: hostSession.id, token: `${hostSession.token.slice(0, -1)}${hostSession.token.endsWith('A') ? 'B' : 'A'}` },
    { code, id: hostSession.id, token: nonCanonicalTokenAlias(hostSession.token) },
  ];
  for (const payload of invalidAttempts) {
    const attacker = await connect();
    const rejected = next(attacker, (message) => message.type === 'error');
    send(attacker, { type: 'resume', ...payload });
    assert.match((await rejected).message, /Unable to resume/);
    await close(attacker);
  }
  assert.equal(player.connected, false);

  const resumed = await connect();
  const replacementSession = next(resumed, (message) => message.type === 'session');
  const resumedState = next(resumed, (message) => message.type === 'state');
  send(resumed, { type: 'resume', code, id: hostSession.id, token: hostSession.token });
  const [replacement, state] = await Promise.all([replacementSession, resumedState]);
  assert.notEqual(replacement.token, hostSession.token);
  assert.equal(state.state.you.id, hostSession.id);
  assert.equal(game.getPlayer(hostSession.id), player);
  assert.equal(player.connected, true);
  assert.deepEqual({ role: player.role, bp: player.bp, scoredReady: player.scoredReady, restReady: player.restReady }, before);
  assert.doesNotMatch(JSON.stringify(state), /token/);

  const occupied = await connect();
  const rejected = next(occupied, (message) => message.type === 'error');
  send(occupied, { type: 'resume', code, id: hostSession.id, token: replacement.token });
  assert.match((await rejected).message, /Unable to resume/);
  await close(occupied);

  sockets[0] = resumed;
  await stopRoom(sockets);
  await closeAll(sockets);
});

test('leave removes lobby seats, transfers lobby host, and disconnects active seats without voiding the game', async () => {
  const host = await connect();
  const hostSession = next(host, (message) => message.type === 'session');
  const hostState = next(host, (message) => message.type === 'state');
  send(host, { type: 'create', name: 'Host' });
  const [credentials, created] = await Promise.all([hostSession, hostState]);
  const peer = await connect();
  const joined = next(peer, (message) => message.type === 'state');
  send(peer, { type: 'join', name: 'Peer', code: created.state.code });
  await joined;
  const transferred = next(peer, (message) => message.type === 'state' && message.state.hostId !== credentials.id);
  const left = next(host, (message) => message.type === 'left');
  send(host, { type: 'leave' });
  const [transferredState] = await Promise.all([transferred, left]);
  assert.equal(server.rooms.get(created.state.code).hostId, transferredState.state.you.id);

  const newSession = next(host, (message) => message.type === 'session');
  const newState = next(host, (message) => message.type === 'state');
  send(host, { type: 'create', name: 'New Host' });
  await Promise.all([newSession, newState]);
  await close(host);
  await close(peer);

  const active = await createStartedRoom();
  const activeLeft = next(active.sockets[0], (message) => message.type === 'left');
  const disconnected = next(active.sockets[1], (message) => message.type === 'state' &&
    message.state.players.find((seat) => seat.id === active.sessions[0].id)?.connected === false);
  send(active.sockets[0], { type: 'leave' });
  await Promise.all([activeLeft, disconnected]);
  assert.equal(active.game.phase, 'roles');
  assert.equal(active.game.getPlayer(active.sessions[0].id).connected, false);
  const revokedResume = await connect();
  const revoked = next(revokedResume, (message) => message.type === 'error');
  send(revokedResume, { ...active.sessions[0], type: 'resume' });
  assert.match((await revoked).message, /Unable to resume/);
  await close(revokedResume);
  const replacementRoom = next(active.sockets[0], (message) => message.type === 'session');
  send(active.sockets[0], { type: 'create', name: 'Moved On' });
  await replacementRoom;
  await stopRoom(active.sockets.slice(1));
  await closeAll(active.sockets);
});

test('room maps are isolated and completed rooms expire through the testable cleanup clock', async () => {
  let current = 0;
  const isolated = createServer({ port: 0, now: () => current, completedRoomRetentionMs: 100 });
  await isolated.listen();
  const { port } = isolated.httpServer.address();
  const isolatedBase = `http://127.0.0.1:${port}`;
  const unbound = await connect(isolatedBase);
  const unboundClosed = once(unbound, 'close');
  assert.notStrictEqual(server.rooms, isolated.rooms);
  assert.notStrictEqual(server.clients, isolated.clients);

  const socket = await connect(isolatedBase);
  const created = next(socket, (message) => message.type === 'state');
  send(socket, { type: 'create', name: 'Cleanup' });
  const { state } = await created;
  const game = isolated.rooms.get(state.code);
  game.finish('draw', 'test');
  isolated.cleanupRooms(current);
  current = 100;
  isolated.cleanupRooms(current);
  assert.equal(isolated.rooms.has(state.code), true);
  await close(socket);
  isolated.cleanupRooms(current);
  assert.equal(isolated.rooms.has(state.code), true);
  current = 199;
  isolated.cleanupRooms(current);
  assert.equal(isolated.rooms.has(state.code), true);
  current = 200;
  isolated.cleanupRooms(current);
  assert.equal(isolated.rooms.has(state.code), false);
  await isolated.close();
  await unboundClosed;
});
