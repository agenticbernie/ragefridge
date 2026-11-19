(() => {
  'use strict';

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const state = {
    socket: null,
    socketId: 0,
    connected: false,
    reconnecting: false,
    reconnectTimer: null,
    reconnectStartedAt: 0,
    reconnectAttempt: 0,
    resumeFailed: false,
    resumedThisConnection: false,
    session: null,
    pending: null,
    latest: null,
    events: [],
    roomMode: 'create',
    roomReturnFocus: null,
    infoReturnFocus: null,
    roleHeld: false,
    actionNotice: null,
  };

  const actionLabels = { roast: 'ROAST', compliment: 'COMPLIMENT', rest: 'REST', deflect: 'DEFLECT' };
  const actionSymbols = { roast: 'snow', compliment: 'heart', rest: 'cup', deflect: 'shield' };
  const reconnectWindowMs = 13_500;
  const focusableSelector = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
  }
  function icon(name) { return `<svg aria-hidden="true"><use href="assets/icons.svg#${name}"></use></svg>`; }
  function seatArt(index) { return `<svg viewBox="0 0 80 80" role="img" aria-label="Player portrait"><use href="assets/cast.svg#seat-${(index % 4) + 1}"></use></svg>`; }
  function formatTime(seconds) {
    const safe = Math.max(0, Number(seconds) || 0);
    return `${String(Math.floor(safe / 60)).padStart(2, '0')}:${String(Math.floor(safe % 60)).padStart(2, '0')}`;
  }
  function numberTemp(value) {
    const number = Math.round(Number(value) || 0);
    return `${number > 0 ? '+' : ''}${number}°`;
  }
  function setView(view) {
    $('#lobby-view').classList.toggle('is-hidden', view !== 'home');
    $('#game-view').classList.toggle('is-hidden', view === 'home');
    $('#lobby-panel').classList.toggle('is-hidden', view !== 'room');
    $('#active-panel').classList.toggle('is-hidden', view !== 'active');
    $('#result-panel').classList.toggle('is-hidden', view !== 'result');
  }
  function showToast(message) {
    const toast = $('#toast');
    toast.textContent = message;
    toast.classList.add('show');
    window.clearTimeout(showToast.timeout);
    showToast.timeout = window.setTimeout(() => toast.classList.remove('show'), 4_000);
  }
  function setConnection(connected, label) {
    state.connected = connected;
    $('#connection-label').textContent = connected ? 'ROOM LINK ACTIVE' : label || 'OFFLINE';
    $('#hud-connection').textContent = connected ? 'CONNECTED' : label || 'OFFLINE';
    const dot = $('.status-dot');
    if (dot) {
      dot.style.background = connected ? '#75ce9d' : '#df937f';
      dot.style.boxShadow = connected ? '0 0 0 4px rgba(117,206,157,.1)' : '0 0 0 4px rgba(223,147,127,.1)';
    }
  }

  function focusInDialog(dialog) {
    const initial = dialog.id === 'room-dialog' && !$('#player-name').disabled ? $('#player-name') : $('.dialog-close', dialog);
    window.setTimeout(() => (initial || dialog).focus(), 0);
  }
  function openRoomDialog(clearError = true) {
    if (!state.roomReturnFocus) state.roomReturnFocus = document.activeElement;
    $('#room-dialog').classList.remove('is-hidden');
    $('#room-dialog').setAttribute('aria-hidden', 'false');
    if (clearError) $('#room-error').textContent = '';
    focusInDialog($('#room-dialog'));
  }
  function closeRoomDialog(returnFocus = true) {
    $('#room-dialog').classList.add('is-hidden');
    $('#room-dialog').setAttribute('aria-hidden', 'true');
    if (returnFocus && state.roomReturnFocus instanceof HTMLElement) state.roomReturnFocus.focus();
    state.roomReturnFocus = null;
  }
  function openInfoDialog(title, kicker, content) {
    state.infoReturnFocus = document.activeElement;
    $('#info-title').textContent = title;
    $('#info-kicker').textContent = kicker;
    $('#info-content').innerHTML = content;
    $('#info-dialog').classList.remove('is-hidden');
    $('#info-dialog').setAttribute('aria-hidden', 'false');
    focusInDialog($('#info-dialog'));
  }
  function closeInfoDialog() {
    $('#info-dialog').classList.add('is-hidden');
    $('#info-dialog').setAttribute('aria-hidden', 'true');
    if (state.infoReturnFocus instanceof HTMLElement) state.infoReturnFocus.focus();
    state.infoReturnFocus = null;
  }
  function trapFocus(event) {
    const dialog = !$('#room-dialog').classList.contains('is-hidden') ? $('#room-dialog') : !$('#info-dialog').classList.contains('is-hidden') ? $('#info-dialog') : null;
    if (!dialog || event.key !== 'Tab') return false;
    const focusable = $$(focusableSelector, dialog).filter((element) => !element.closest('.is-hidden'));
    if (!focusable.length) return false;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
    return true;
  }

  function authoredRulesMarkup() {
    return `
      <p>At the five-minute buzzer, the shared fridge must have spent the <b>last 10 seconds at or below −10°C</b> to earn a cold win. An earlier cold hold does not carry forward. Your BP is a cartoon game meter, not medical data.</p>
      <h3>Authored actions</h3>
      <dl class="rules-list">
        <div><dt>Roast I <kbd>1</kbd></dt><dd>−2°C; you +4 BP; target +2 BP.</dd></div>
        <div><dt>Roast II <kbd>2</kbd></dt><dd>−4°C; you +7 BP; target +4 BP.</dd></div>
        <div><dt>Roast III <kbd>3</kbd></dt><dd>−6°C; you +11 BP; target +6 BP.</dd></div>
        <div><dt>Compliment <kbd>C</kbd></dt><dd>+2°C; you +1 BP; target −3 BP.</dd></div>
        <div><dt>Rest <kbd>R</kbd></dt><dd>For 4 seconds, recover 3 BP each second. 18-second cooldown.</dd></div>
        <div><dt>Deflect <kbd>F</kbd></dt><dd>Protects only you for 3 seconds; the next incoming roast's BP impact is halved. 12-second cooldown.</dd></div>
      </dl>
      <h3>Private roles and targets</h3>
      <ul><li>Your role card is private. Press and hold the role button to peek; releasing, blurring, or moving away hides it.</li><li>Choose a living target before a roast or compliment. Deflect has no target and protects only your own seat.</li></ul>
      <h3>Fair-play limits</h3>
      <ul><li>Roast and compliment actions have a 6-second cooldown.</li><li>The same roast tier cannot cool twice within 30 seconds.</li><li>A player can be roast-targeted twice within 10 seconds; further roasts show as protected and have no cooling or target-BP effect.</li><li>Back-to-back roasts on the same target within 12 seconds cool at half strength.</li></ul>
      <p class="info-note">Actions use fixed, authored values. Free text and AI scoring are not part of this prototype. Safety Stop ends an active match with no payout or settlement.</p>`;
  }
  function openRules() { openInfoDialog('How it works', 'KITCHEN RULES', authoredRulesMarkup()); }
  function eventLogMarkup() {
    const events = state.events;
    if (!events.length) return '<p class="info-note">No room events have arrived yet.</p>';
    return `<div class="full-event-log">${events.map((event) => {
      const type = event.type || '';
      const time = event.at != null ? formatTime(event.at) : 'NOW';
      return `<div class="event-item ${type.includes('roast') || type.includes('cold') ? 'cold' : type.includes('compliment') || type.includes('heat') ? 'hot' : ''}"><span class="event-time">${time}</span><strong>${escapeHtml(event.text || event.message || type || 'Kitchen event')}</strong></div>`;
    }).join('')}</div>`;
  }
  function openEventLog() { openInfoDialog('Event log', 'KITCHEN TELEGRAM', eventLogMarkup()); }

  function setRoomMode(mode) {
    if (state.pending) return;
    state.roomMode = mode;
    const joining = mode === 'join';
    $('#create-choice').classList.toggle('is-selected', !joining);
    $('#join-choice').classList.toggle('is-selected', joining);
    $('#room-code-field').classList.toggle('is-hidden', !joining);
    $('#room-submit span').textContent = joining ? 'JOIN ROOM' : 'CREATE ROOM';
  }
  function setRoomBusy(busy) {
    $('#room-submit').disabled = busy;
    $('#demo-submit').disabled = busy;
    $('#create-choice').disabled = busy;
    $('#join-choice').disabled = busy;
    $('#player-name').disabled = busy;
    $('#room-code').disabled = busy;
    if (busy) $('#room-submit span').textContent = state.roomMode === 'join' ? 'JOINING…' : 'CREATING…';
    else $('#room-submit span').textContent = state.roomMode === 'join' ? 'JOIN ROOM' : 'CREATE ROOM';
  }
  function sanitizedName() {
    return $('#player-name').value.replace(/[\u0000-\u001f]/g, '').trim().slice(0, 18);
  }
  function sanitizedCode() {
    return $('#room-code').value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
  }
  function roomSubmit(demo = false) {
    if (state.pending) return;
    const name = sanitizedName();
    const code = sanitizedCode();
    $('#player-name').value = name;
    $('#room-code').value = code;
    if (!name) {
      $('#room-error').textContent = 'Give your cook a kitchen name first.';
      $('#player-name').focus();
      return;
    }
    if (!demo && state.roomMode === 'join' && code.length < 4) {
      $('#room-error').textContent = 'Enter the room code from your host.';
      $('#room-code').focus();
      return;
    }
    leaveSocket({ notifyServer: true, keepView: true });
    state.latest = null;
    state.events = [];
    state.pending = { kind: 'room', mode: state.roomMode };
    setRoomBusy(true);
    $('#room-error').textContent = '';
    openSocket({ type: demo ? 'create' : state.roomMode, name, code: state.roomMode === 'join' ? code : undefined, demo });
  }

  function clearReconnectTimer() {
    window.clearTimeout(state.reconnectTimer);
    state.reconnectTimer = null;
  }
  function leaveSocket({ notifyServer = false, keepView = false } = {}) {
    clearReconnectTimer();
    state.reconnecting = false;
    state.reconnectAttempt = 0;
    state.reconnectStartedAt = 0;
    state.resumeFailed = false;
    state.resumedThisConnection = false;
    const socket = state.socket;
    state.socket = null;
    state.socketId += 1;
    state.connected = false;
    if (socket) {
      if (notifyServer && socket.readyState === WebSocket.OPEN) {
        try { socket.send(JSON.stringify({ type: 'leave' })); } catch (_) {}
      }
      try { socket.close(); } catch (_) {}
    }
    state.session = null;
    state.pending = null;
    if (!keepView) setConnection(false, 'OFFLINE');
  }
  function openSocket(payload, { resume = false } = {}) {
    const socketId = ++state.socketId;
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    let socket;
    try {
      socket = new WebSocket(`${protocol}//${window.location.host}/ws`);
    } catch (_) {
      onSocketClose(socketId, resume);
      return;
    }
    state.socket = socket;
    setConnection(false, resume ? 'RECONNECTING…' : 'CONNECTING…');
    socket.addEventListener('open', () => {
      if (socketId !== state.socketId || socket !== state.socket) return;
      try { socket.send(JSON.stringify(payload)); } catch (_) { try { socket.close(); } catch (ignore) {} }
    });
    socket.addEventListener('message', (event) => {
      if (socketId !== state.socketId || socket !== state.socket) return;
      let message;
      try { message = JSON.parse(event.data); } catch (_) { return; }
      handleMessage(message);
    });
    socket.addEventListener('close', () => onSocketClose(socketId, resume));
    socket.addEventListener('error', () => {});
  }
  function onSocketClose(socketId, wasResume) {
    if (socketId !== state.socketId) return;
    state.socket = null;
    state.connected = false;
    if (state.pending?.kind === 'room') {
      state.pending = null;
      setRoomBusy(false);
      setConnection(false, 'ROOM REQUEST FAILED');
      $('#room-error').textContent = 'The kitchen connection closed before your room was confirmed. Your form is still here—try again.';
      openRoomDialog(false);
      return;
    }
    if (state.latest?.phase === 'lobby') {
      state.session = null;
      state.latest = null;
      state.events = [];
      setConnection(false, 'LOBBY SEAT RELEASED');
      setView('home');
      $('#room-error').textContent = 'The lobby connection closed, so that seat was released. Create or join a room again.';
      openRoomDialog(false);
      return;
    }
    if (!state.session || state.resumeFailed) {
      setConnection(false, state.resumeFailed ? 'REJOIN FAILED' : 'OFFLINE');
      updateActionButtons(state.latest?.you || {});
      return;
    }
    setConnection(false, 'RECONNECTING…');
    updateActionButtons(state.latest?.you || {});
    if (!wasResume) showToast('Connection lost. Reconnecting your open-page seat; the server keeps its own 15-second grace window.');
    scheduleReconnect();
  }
  function scheduleReconnect() {
    if (!state.session || state.resumeFailed || state.reconnectTimer || state.socket) return;
    const now = Date.now();
    if (!state.reconnectStartedAt) state.reconnectStartedAt = now;
    if (now - state.reconnectStartedAt >= reconnectWindowMs) {
      state.reconnecting = false;
      setConnection(false, 'REJOIN WINDOW ENDED');
      updateActionButtons(state.latest?.you || {});
      showToast('Could not reconnect this open-page seat. A page refresh never recovers a seat; create or join a room again.');
      return;
    }
    state.reconnecting = true;
    const delay = Math.min(2_000, 250 * (2 ** state.reconnectAttempt++));
    state.reconnectTimer = window.setTimeout(() => {
      state.reconnectTimer = null;
      const session = state.session;
      if (!session || state.socket) return;
      openSocket({ type: 'resume', code: session.code, id: session.id, token: session.token }, { resume: true });
    }, delay);
  }
  function handleMessage(message) {
    if (message.type === 'session') {
      if (typeof message.code === 'string' && typeof message.id === 'string' && typeof message.token === 'string') {
        // Intentionally in-memory only: never persist or log the resume credential.
        state.session = { code: message.code, id: message.id, token: message.token };
        if (state.reconnecting) state.resumedThisConnection = true;
        state.reconnecting = false;
        state.resumeFailed = false;
        state.reconnectAttempt = 0;
        state.reconnectStartedAt = 0;
      }
      return;
    }
    if (message.type === 'left') {
      clearReconnectTimer();
      state.session = null;
      state.pending = null;
      setConnection(false, 'OFFLINE');
      return;
    }
    if (message.type === 'error') {
      const detail = message.message || 'The kitchen rejected that request.';
      if (state.pending?.kind === 'room') {
        state.pending = null;
        setRoomBusy(false);
        setConnection(false, 'ROOM REQUEST FAILED');
        $('#room-error').textContent = detail;
        openRoomDialog(false);
      } else if (state.reconnecting) {
        // The server may still be unbinding the old socket. Retry the same in-memory credential through its grace window.
        const retrySocket = state.socket;
        state.socket = null;
        state.socketId += 1;
        try { retrySocket?.close(); } catch (_) {}
        if (Date.now() - state.reconnectStartedAt < reconnectWindowMs) {
          setConnection(false, 'RECONNECTING…');
          updateActionButtons(state.latest?.you || {});
          scheduleReconnect();
        } else {
          state.reconnecting = false;
          state.resumeFailed = true;
          setConnection(false, 'REJOIN FAILED');
          updateActionButtons(state.latest?.you || {});
          showToast('Unable to rejoin this seat. Refreshing cannot recover it; create or join a new room.');
        }
      } else {
        state.actionNotice = { text: detail, until: Date.now() + 4_000 };
        $('#action-status').textContent = detail;
        showToast(detail);
      }
      return;
    }
    if (message.type !== 'state' || !message.state) return;
    state.latest = message.state;
    const recovered = state.reconnecting || state.resumedThisConnection;
    state.resumedThisConnection = false;
    state.events = Array.isArray(message.state.events) ? message.state.events.slice() : [];
    state.pending = null;
    state.reconnecting = false;
    clearReconnectTimer();
    setRoomBusy(false);
    setConnection(true);
    if (recovered) showToast('Reconnected to the kitchen.');
    closeRoomDialog(false);
    const phase = message.state.phase;
    if (phase === 'lobby') {
      setView('room');
      renderLobby(message.state);
    } else if (phase === 'roles' || phase === 'active' || phase === 'suddenDeath') {
      setView('active');
      renderActive(message.state);
    } else if (phase === 'ended') {
      concealRole();
      setView('result');
      renderResult(message.state);
    }
  }
  function send(payload) {
    if (!state.socket || state.socket.readyState !== WebSocket.OPEN || !state.connected || state.reconnecting) {
      showToast('Actions are unavailable while the kitchen connection is reconnecting.');
      return false;
    }
    try {
      state.socket.send(JSON.stringify(payload));
      return true;
    } catch (_) {
      showToast('The kitchen connection closed before that action could be sent.');
      return false;
    }
  }

  function renderLobby(room) {
    $('#room-code-display').textContent = room.code || '----';
    const players = Array.isArray(room.players) ? room.players : [];
    const seats = $('#lobby-seats');
    seats.innerHTML = '';
    players.forEach((player, index) => {
      seats.insertAdjacentHTML('beforeend', `<article class="seat-card ready"><img src="assets/cast.svg" alt="" class="seat-svg" data-seat="${index}"><span class="seat-number">SEAT 0${index + 1}</span><div><p class="seat-name">${escapeHtml(player.name || 'Kitchen guest')}</p><span class="seat-status">${player.connected === false ? 'RECONNECTING' : 'READY'}</span></div>${player.bot ? '<span class="seat-bot">BOT DEMO</span>' : ''}</article>`);
    });
    for (let index = players.length; index < 4; index += 1) seats.insertAdjacentHTML('beforeend', `<article class="seat-card empty"><span class="seat-number">SEAT 0${index + 1}</span><div><p class="seat-name">OPEN SEAT</p><span class="seat-status">INVITE A PLAYER</span></div></article>`);
    $$('.seat-svg', seats).forEach((image, index) => { image.outerHTML = seatArt(index); });
    const count = players.length;
    const canStart = room.canStart !== undefined ? room.canStart : Boolean(room.hostId && room.hostId === room.you?.id && count >= 4);
    $('#ready-summary').textContent = count >= 4 ? 'All seats ready — host can start' : `${count} of 4 seats filled — waiting for ${4 - count}`;
    $('#start-match').disabled = !canStart;
    if (room.demo) {
      $('#start-match').disabled = false;
      $('#ready-summary').textContent = 'Single-browser bot demo — all seats ready';
    }
  }
  function playerClass(bpBand) { return ['calm', 'active', 'simmering', 'danger', 'critical', 'eliminated'].includes(bpBand) ? bpBand : 'active'; }
  function renderActive(room) {
    const players = Array.isArray(room.players) ? room.players : [];
    const me = room.you || {};
    renderSharedStatus(room);
    renderPlayers(players, me);
    renderYou(me, players);
    renderEvents(state.events);
    updateTargetSelect(players, me);
    updateActionButtons(me);
  }
  function renderSharedStatus(room) {
    $('#timer').textContent = formatTime(room.phase === 'roles' ? room.roleRemaining : room.remaining);
    $('#phase-label').textContent = room.phase === 'roles' ? 'PRIVATE ROLE CARD' : room.phase === 'suddenDeath' ? 'SUDDEN DEATH' : 'KITCHEN MELTDOWN';
    $('#crew-count').textContent = `${Array.isArray(room.players) ? room.players.length : 0} / 4`;
    $('#temperature').innerHTML = `${numberTemp(room.temperature)}<small>C</small>`;
    const hot = Number(room.temperature) >= 70;
    const frozen = Number(room.temperature) <= -10;
    const pill = $('#temperature-state');
    pill.className = `state-pill ${frozen ? 'cold' : hot ? 'hot' : 'warm'}`;
    pill.innerHTML = `<span class="state-dot"></span> ${frozen ? 'FROZEN' : hot ? 'BOILING' : 'WARMING'}`;
    $('#fridge-readout-value').textContent = frozen ? 'FROZEN SOLID' : hot ? 'ABOUT TO POP' : Number(room.temperature) >= 40 ? 'SWEATING' : 'WORRIED';
    const hold = Math.max(0, Math.min(10, Number(room.coldHold) || 0));
    $('#hold-value').innerHTML = `${Math.floor(hold)} <small>/ 10 SEC</small>`;
    $('#hold-fill').style.width = `${hold * 10}%`;
    $('#hold-note').textContent = hold >= 10 ? 'Cold now—maintain it through the final buzzer.' : frozen ? 'Only the final 10 seconds at or below −10°C decide a cold win.' : 'A cold win needs the final 10 seconds at or below −10°C.';
  }
  function renderPlayers(players, me) {
    const list = $('#player-list');
    list.innerHTML = players.map((player, index) => {
      const isYou = player.id && player.id === me.id;
      const band = player.alive === false ? 'eliminated' : playerClass(player.bpBand);
      return `<article class="player-row ${isYou ? 'is-you' : ''} ${player.alive === false ? 'is-dead' : ''}"><img src="assets/cast.svg" data-seat="${index}" alt=""><div><span class="player-name">${escapeHtml(player.name || 'Kitchen guest')}${isYou ? ' <small>(YOU)</small>' : ''}</span><span class="player-state">${player.alive === false ? 'ELIMINATED' : player.connected === false ? 'DISCONNECTED' : band.toUpperCase()}</span></div><span class="player-bp ${band}">${band === 'eliminated' ? 'OUT' : band.toUpperCase()}</span></article>`;
    }).join('');
    $$('.player-row img', list).forEach((image, index) => { image.outerHTML = seatArt(index); });
  }
  function renderYou(me, players) {
    const yourName = players.find((player) => player.id === me.id)?.name || me.name || 'Kitchen guest';
    $('#you-name').textContent = yourName;
    const bp = Math.round(Number(me.bp) || 0);
    $('#your-bp').textContent = bp;
    const band = playerClass(me.bpBand || (bp < 20 ? 'calm' : bp < 50 ? 'active' : bp < 75 ? 'simmering' : 'danger'));
    $('#your-band').textContent = band.toUpperCase();
    $('#your-band').style.color = band === 'calm' ? '#83c7b5' : band === 'active' ? '#e8be63' : '#e37963';
    if (!state.roleHeld) concealRole();
  }
  function updateTargetSelect(players, me) {
    const select = $('#target-select');
    const current = select.value;
    const targetable = players.filter((player) => player.id !== me.id && player.alive !== false && player.connected !== false);
    select.innerHTML = targetable.map((player) => `<option value="${escapeHtml(player.id)}">${escapeHtml(player.name || 'Kitchen guest')}${player.protected ? ' — ROAST PROTECTED' : ''}</option>`).join('');
    if ([...select.options].some((option) => option.value === current)) select.value = current;
    select.disabled = !targetable.length;
  }
  function selectedTarget() {
    const id = $('#target-select').value;
    return state.latest?.players?.find((player) => player.id === id) || null;
  }
  function readyButtonLabel(button) { return button.dataset.readyLabel || button.querySelector('small')?.textContent || ''; }
  function restoreButtonLabels() {
    $$('.action-button').forEach((button) => {
      const label = button.querySelector('small');
      if (label) label.textContent = readyButtonLabel(button);
    });
  }
  function updateActionButtons(me) {
    const cooldown = Number(me.cooldown) || 0;
    const restCooldown = Number(me.restCooldown) || 0;
    const deflectCooldown = Number(me.deflectCooldown) || 0;
    const resting = Number(me.resting) || 0;
    const dead = me.alive === false;
    const roleCard = state.latest?.phase === 'roles';
    const noConnection = !state.connected || state.reconnecting;
    const target = selectedTarget();
    restoreButtonLabels();
    $$('.action-button').forEach((button) => {
      const action = button.dataset.action;
      const label = button.querySelector('small');
      let reason = '';
      if (noConnection) reason = 'RECONNECTING';
      else if (roleCard) reason = 'ROLE REVEAL';
      else if (dead) reason = 'SEAT OUT';
      else if ((action === 'roast' || action === 'compliment') && resting > 0) reason = `RESTING ${Math.ceil(resting)}S`;
      else if ((action === 'roast' || action === 'compliment') && cooldown > 0) reason = `READY IN ${Math.ceil(cooldown)}S`;
      else if (action === 'rest' && restCooldown > 0) reason = `READY IN ${Math.ceil(restCooldown)}S`;
      else if (action === 'deflect' && deflectCooldown > 0) reason = `READY IN ${Math.ceil(deflectCooldown)}S`;
      else if ((action === 'roast' || action === 'compliment') && !target) reason = 'CHOOSE TARGET';
      else if (action === 'roast' && target?.protected) reason = 'TARGET PROTECTED';
      button.disabled = Boolean(reason);
      if (reason && label) label.textContent = reason;
    });
    const status = $('#action-status');
    if (state.actionNotice && state.actionNotice.until <= Date.now()) state.actionNotice = null;
    if (noConnection) status.textContent = 'Reconnecting. Actions stay disabled until the server confirms this seat; server time keeps running.';
    else if (state.actionNotice) status.textContent = state.actionNotice.text;
    else if (roleCard) status.textContent = 'Role card reveal is in progress. Press and hold the role button to peek; actions open when the countdown ends.';
    else if (dead) status.textContent = 'This seat is out of the match.';
    else if (target?.protected) status.textContent = 'Selected target is roast-protected: a roast would add no cooling or target BP. Choose another target or wait.';
    else if (resting > 0) status.textContent = `Resting for ${Math.ceil(resting)} more second${Math.ceil(resting) === 1 ? '' : 's'}: roast and compliment are unavailable.`;
    else status.textContent = 'Roast and compliment: 6s cooldown. Rest: 18s cooldown. Deflect: 12s cooldown. All actions use authored, fixed values.';
  }
  function renderEvents(events) {
    const list = $('#events-log');
    const recent = events.slice(-8).reverse();
    list.innerHTML = recent.length ? recent.map((event) => {
      const type = event.type || '';
      const time = event.at != null ? formatTime(event.at) : 'NOW';
      return `<div class="event-item ${type.includes('roast') || type.includes('cold') ? 'cold' : type.includes('compliment') || type.includes('heat') ? 'hot' : ''}"><span class="event-time">${time}</span><strong>${escapeHtml(event.text || event.message || type || 'Kitchen event')}</strong></div>`;
    }).join('') : '<div class="event-item"><span class="event-time">NOW</span><strong>The fridge is listening.</strong><br>Make the first move.</div>';
  }
  function outcomeReason(reason) {
    const labels = {
      coldHold: 'The core stayed at or below −10°C for the full 10-second cold hold.',
      overheat: 'The shared temperature reached 100°C before the kitchen could cool it.',
      saboteurEliminated: 'The Saboteur was eliminated before the fridge overheated.',
      coldTeamEliminated: 'No eligible cold-team player remained.',
      missedColdHold: 'Time expired without a 10-second hold at −10°C or colder.',
      safetyStop: 'A player ended the match with Safety Stop.',
    };
    return labels[reason] || 'The match ended without a decisive kitchen outcome.';
  }
  function outcomeWeight(result, player, type) {
    if (type === 'void') return 'NO MATCH OUTCOME';
    if (Number(result?.weight) > 0) return `${result.weight} / 100 OUTCOME WEIGHT`;
    if (player.alive === false || result?.alive === false) return 'ELIMINATED — NO OUTCOME WEIGHT';
    return 'NOT ELIGIBLE FOR THIS OUTCOME';
  }
  function renderResult(room) {
    const outcome = room.outcome || {};
    const type = outcome.type || 'void';
    const cold = type === 'cold';
    const sabotage = type === 'sabotage';
    $('#result-stamp').textContent = type === 'void' ? 'TECHNICAL VOID' : 'MATCH COMPLETE';
    $('#result-title').textContent = cold ? 'A COLD SNAP.' : sabotage ? 'THE FRIDGE POPPED.' : 'NO WINNER.';
    $('#result-reason').textContent = outcomeReason(outcome.reason);
    const players = Array.isArray(room.players) ? room.players : [];
    const outcomePlayers = Array.isArray(outcome.players) ? outcome.players : [];
    $('#result-players').innerHTML = players.map((player, index) => {
      const result = outcomePlayers.find((item) => item.id === player.id) || {};
      return `<div class="result-player">${seatArt(index)}<b>${escapeHtml(player.name || 'Kitchen guest')}</b><small>${escapeHtml(result.role || player.role || 'ROLE HIDDEN')}</small><span class="outcome-weight">${escapeHtml(outcomeWeight(result, player, type))}</span></div>`;
    }).join('');
  }

  function actionProblem(action) {
    const room = state.latest;
    const me = room?.you || {};
    if (!room || !state.connected || state.reconnecting) return 'Actions are unavailable while the kitchen connection is reconnecting.';
    if (room.phase === 'roles') return 'Role card reveal is in progress. Hold to peek, then the kitchen opens.';
    if (me.alive === false) return 'This seat is out of the match.';
    if ((action === 'roast' || action === 'compliment') && Number(me.resting) > 0) return 'You cannot roast or compliment while resting.';
    if ((action === 'roast' || action === 'compliment') && Number(me.cooldown) > 0) return `That scored action is ready in ${Math.ceil(me.cooldown)} seconds.`;
    if (action === 'rest' && Number(me.restCooldown) > 0) return `Rest is ready in ${Math.ceil(me.restCooldown)} seconds.`;
    if (action === 'deflect' && Number(me.deflectCooldown) > 0) return `Deflect is ready in ${Math.ceil(me.deflectCooldown)} seconds.`;
    if ((action === 'roast' || action === 'compliment') && !selectedTarget()) return 'Choose another living player first.';
    if (action === 'roast' && selectedTarget()?.protected) return 'That target is currently roast-protected. Choose another player or wait.';
    return '';
  }
  function sendAction(action, tier) {
    const problem = actionProblem(action);
    if (problem) {
      $('#action-status').textContent = problem;
      showToast(problem);
      return;
    }
    const payload = { type: 'action', action };
    if (action === 'roast' || action === 'compliment') payload.target = $('#target-select').value;
    if (action === 'roast') payload.tier = Number(tier);
    if (send(payload)) {
      state.actionNotice = null;
      triggerImpact(action);
    }
  }
  function triggerImpact(action) {
    const vfx = $('#fridge-vfx');
    vfx.className = `fridge-vfx ${action === 'compliment' ? 'warm' : action === 'roast' ? 'cool' : ''}`;
    window.setTimeout(() => { vfx.className = 'fridge-vfx'; }, 500);
  }
  function revealRole() {
    const role = state.latest?.you?.role;
    if (!role || state.latest?.phase === 'ended') {
      showToast('Your private role arrives when the match starts.');
      return;
    }
    const labels = { chef: 'CHEF', saboteur: 'SABOTEUR', stoic: 'STOIC' };
    $('#role-peek').textContent = `YOU ARE THE ${labels[role] || String(role).toUpperCase()}`;
    state.roleHeld = true;
  }
  function concealRole() {
    state.roleHeld = false;
    $('#role-peek').innerHTML = 'HOLD TO PEEK ROLE <span aria-hidden="true">◉</span>';
  }
  function leaveAndOpenNewRoom() {
    concealRole();
    leaveSocket({ notifyServer: true });
    state.latest = null;
    state.events = [];
    setRoomMode('create');
    setView('home');
    openRoomDialog();
  }

  $('#open-room').addEventListener('click', openRoomDialog);
  $('#close-room').addEventListener('click', () => closeRoomDialog());
  $('#room-dialog').addEventListener('click', (event) => { if (event.target === $('#room-dialog')) closeRoomDialog(); });
  $('#close-info').addEventListener('click', closeInfoDialog);
  $('#info-dialog').addEventListener('click', (event) => { if (event.target === $('#info-dialog')) closeInfoDialog(); });
  $('#create-choice').addEventListener('click', () => setRoomMode('create'));
  $('#join-choice').addEventListener('click', () => setRoomMode('join'));
  $('#room-submit').addEventListener('click', () => roomSubmit(false));
  $('#demo-submit').addEventListener('click', () => roomSubmit(true));
  $('#open-how').addEventListener('click', openRules);
  $('#lobby-rules').addEventListener('click', openRules);
  $('#open-log').addEventListener('click', openEventLog);
  $('#result-log').addEventListener('click', openEventLog);
  $('#copy-code').addEventListener('click', async () => {
    const code = $('#room-code-display').textContent;
    try { await navigator.clipboard.writeText(code); showToast(`Room code ${code} copied.`); } catch (_) { showToast(`Room code: ${code}`); }
  });
  $('#start-match').addEventListener('click', () => { if (send({ type: 'start' })) showToast('The kitchen is opening. Keep your cool.'); });
  $('#safety-stop').addEventListener('click', () => {
    if (window.confirm('Safety Stop ends this room in a technical void. No score, payout, or settlement is created. Continue?')) send({ type: 'stop' });
  });
  $('#read-status').addEventListener('click', () => {
    const room = state.latest;
    if (!room) return;
    const me = room.you || {};
    const announcement = `Shared temperature ${Math.round(Number(room.temperature) || 0)} degrees Celsius. Your BP ${Math.round(Number(me.bp) || 0)} out of 100. ${room.coldHold || 0} seconds of cold hold.`;
    const live = $('#read-status');
    live.setAttribute('aria-label', announcement);
    showToast(announcement);
  });
  $('#play-again').addEventListener('click', leaveAndOpenNewRoom);
  $('#leave-room').addEventListener('click', leaveAndOpenNewRoom);
  $$('.action-button').forEach((button) => {
    const label = button.querySelector('small');
    if (label) button.dataset.readyLabel = label.textContent;
    button.addEventListener('click', () => sendAction(button.dataset.action, button.dataset.tier));
  });
  $('#target-select').addEventListener('change', () => updateActionButtons(state.latest?.you || {}));
  $('#role-peek').addEventListener('pointerdown', (event) => { event.preventDefault(); revealRole(); });
  $('#role-peek').addEventListener('pointerup', concealRole);
  $('#role-peek').addEventListener('pointercancel', concealRole);
  $('#role-peek').addEventListener('pointerleave', concealRole);
  $('#role-peek').addEventListener('blur', concealRole);
  $('#role-peek').addEventListener('keydown', (event) => {
    if ((event.key === 'Enter' || event.key === ' ') && !event.repeat) { event.preventDefault(); revealRole(); }
  });
  $('#role-peek').addEventListener('keyup', (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); concealRole(); } });
  document.addEventListener('pointerup', concealRole);
  document.addEventListener('keydown', (event) => {
    if (trapFocus(event)) return;
    if (event.key === 'Escape') {
      if (!$('#info-dialog').classList.contains('is-hidden')) { event.preventDefault(); closeInfoDialog(); return; }
      if (!$('#room-dialog').classList.contains('is-hidden')) { event.preventDefault(); closeRoomDialog(); return; }
    }
    if ($('#active-panel').classList.contains('is-hidden') || event.target.matches('input, select, textarea, button')) return;
    const key = event.key.toLowerCase();
    if (key === '1') sendAction('roast', 1);
    if (key === '2') sendAction('roast', 2);
    if (key === '3') sendAction('roast', 3);
    if (key === 'c') sendAction('compliment');
    if (key === 'r') sendAction('rest');
    if (key === 'f') sendAction('deflect');
  });

  // Interpolate only while connected. On a transport drop, controls are disabled rather than showing invented cooldown progress.
  window.setInterval(() => {
    const room = state.latest;
    if (!state.connected || !room) return;
    if (room.phase === 'roles') {
      room.roleRemaining = Math.max(0, (Number(room.roleRemaining) || 0) - 1);
      $('#timer').textContent = formatTime(room.roleRemaining);
      return;
    }
    if (room.phase !== 'active' && room.phase !== 'suddenDeath') return;
    room.remaining = Math.max(0, (Number(room.remaining) || 0) - 1);
    const you = room.you || {};
    ['cooldown', 'restCooldown', 'deflectCooldown', 'resting', 'deflecting'].forEach((key) => { you[key] = Math.max(0, (Number(you[key]) || 0) - 1); });
    $('#timer').textContent = formatTime(room.remaining);
    updateActionButtons(you);
  }, 1_000);

  setRoomMode('create');
  setView('home');
})();
