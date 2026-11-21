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
    chainConfig: null,
    walletAuth: null,
    chainProgress: null,
    chainProgressKey: '',
    chainProgressAt: 0,
    chainInspecting: false,
    chainTxBusy: false,
    chainPendingTx: null,
    chainMessage: '',
    chainError: '',
    walletAddressBound: null,
    walletBindingInvalid: false,
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
    historyGeneration++;
    if ($('#info-dialog').classList.contains('is-hidden')) state.infoReturnFocus = document.activeElement;
    $('#info-title').textContent = title;
    $('#info-kicker').textContent = kicker;
    $('#info-content').innerHTML = content;
    $('#info-dialog').classList.remove('is-hidden');
    $('#info-dialog').setAttribute('aria-hidden', 'false');
    focusInDialog($('#info-dialog'));
  }
  function closeInfoDialog() {
    historyGeneration++;
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
    const chainDisclosure = state.latest?.mode === 'fuji'
      ? '<p class="info-note">This room uses nonredeemable RFC test credits. Wallet transactions are separate, require Fuji test AVAX gas, and may be refundable if the match is void or times out. No real-value payout is offered.</p>'
      : '<p class="info-note">Actions use fixed, authored values. Free text and AI scoring are not part of this prototype. Safety Stop ends an active free match without payout or settlement.</p>';
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
      ${chainDisclosure}`;
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
    $('#wallet-mode-field').classList.toggle('is-hidden', !state.chainConfig?.enabled);
    $('#wallet-mode-field').disabled = !state.chainConfig?.enabled || !window.ethereum || Boolean(state.pending);
    $('#wallet-mode').disabled = !state.chainConfig?.enabled || !window.ethereum || Boolean(state.pending);
    if (!window.ethereum) $('#wallet-mode-note').textContent = 'No injected wallet is available in this browser. Free play remains available.';
    else $('#wallet-mode-note').textContent = 'Optional. Connect an EOA to authenticate and use nonredeemable RFC test credits. Each wallet transaction needs Fuji test AVAX for gas.';
    $('#room-submit span').textContent = joining ? 'JOIN ROOM' : 'CREATE ROOM';
  }
  function setRoomBusy(busy) {
    $('#room-submit').disabled = busy;
    $('#demo-submit').disabled = busy;
    $('#create-choice').disabled = busy;
    $('#join-choice').disabled = busy;
    $('#player-name').disabled = busy;
    $('#room-code').disabled = busy;
    $('#wallet-mode-field').disabled = busy || !state.chainConfig?.enabled || !window.ethereum;
    $('#wallet-mode').disabled = busy || !state.chainConfig?.enabled || !window.ethereum;
    if (busy) $('#room-submit span').textContent = state.roomMode === 'join' ? 'JOINING…' : 'CREATING…';
    else $('#room-submit span').textContent = state.roomMode === 'join' ? 'JOIN ROOM' : 'CREATE ROOM';
  }
  function sanitizedName() {
    return $('#player-name').value.replace(/[\u0000-\u001f]/g, '').trim().slice(0, 18);
  }
  function sanitizedCode() {
    return $('#room-code').value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
  }
  async function roomSubmit(demo = false) {
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
    const paid = !demo && $('#wallet-mode').checked;
    leaveSocket({ notifyServer: true, keepView: true });
    state.latest = null;
    state.events = [];
    const pending = { kind: 'room', mode: state.roomMode };
    state.pending = pending;
    setRoomBusy(true);
    $('#room-error').textContent = '';
    try {
      if (paid) {
        if (!state.chainConfig?.enabled) throw new Error('Fuji wallet rooms are not enabled on this server.');
        state.walletAuth = await window.RageFridgeWallet.authenticate(state.chainConfig);
        state.walletAddressBound = state.walletAuth.address;
        state.walletBindingInvalid = false;
      }
      if (state.pending !== pending) return;
      const payload = { type: demo ? 'create' : state.roomMode, name, code: state.roomMode === 'join' ? code : undefined, demo };
      if (paid) {
        payload.paid = true;
        payload.authToken = state.walletAuth.token;
      }
      openSocket(payload);
    } catch (error) {
      if (state.pending !== pending) return;
      state.pending = null;
      state.walletAuth = null;
      state.walletAddressBound = null;
      state.walletBindingInvalid = false;
      window.RageFridgeWallet?.clearAuthentication();
      setRoomBusy(false);
      setConnection(false, 'WALLET SIGN-IN FAILED');
      $('#room-error').textContent = error?.message || 'Wallet sign-in failed. Free play is still available.';
      openRoomDialog(false);
    }
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
    state.walletAuth = null;
    state.walletAddressBound = null;
    state.walletBindingInvalid = false;
    state.chainProgress = null;
    state.chainProgressKey = '';
    state.chainMessage = '';
    state.chainError = '';
    window.RageFridgeWallet?.clearAuthentication();
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
    if (state.latest?.phase === 'lobby' && state.latest?.mode !== 'fuji') {
      state.session = null;
      state.latest = null;
      state.events = [];
      state.walletAuth = null;
      state.walletAddressBound = null;
      state.walletBindingInvalid = false;
      window.RageFridgeWallet?.clearAuthentication();
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
        state.walletAuth = null;
        state.walletAddressBound = null;
        state.walletBindingInvalid = false;
        window.RageFridgeWallet?.clearAuthentication();
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
    renderChain(message.state);
    void refreshChainProgress();
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

  async function loadChainConfig() {
    try {
      const response = await fetch('/api/chain/config', { cache: 'no-store' });
      if (!response.ok) throw new Error(`Chain configuration unavailable (${response.status}).`);
      const config = await response.json();
      state.chainConfig = config?.enabled === true && Number(config.chainId) === 43113
        ? config
        : { enabled: false, chainId: 43113 };
      if (state.chainConfig.enabled) state.chainPendingTx = window.RageFridgeWallet.pendingTransaction(state.chainConfig);
    } catch (_) {
      state.chainConfig = { enabled: false, chainId: 43113 };
    }
    setRoomMode(state.roomMode);
    $('#open-history').classList.toggle('is-hidden', !state.chainConfig.enabled);
  }

  let historyAuth = null;
  let historyLoading = false;
  let historyGeneration = 0;
  async function openHistory(offset = 0) {
    if (historyLoading || state.chainTxBusy) return;
    historyLoading = true;
    openInfoDialog('Fuji claim history', 'PRIVATE WALLET HISTORY', '<p role="status">Sign in with your Fuji wallet to load your matches. Free-play seats are not stored here.</p>');
    const generation = historyGeneration;
    const isCurrent = () => generation === historyGeneration;
    try {
      const auth = historyAuth || await window.RageFridgeWallet.authenticate(state.chainConfig);
      if (!isCurrent()) return;
      historyAuth = auth;
      const response = await fetch(`/api/wallet/matches?offset=${offset}`, {
        headers: { Authorization: `Bearer ${auth.token}` }, cache: 'no-store',
      });
      if (!isCurrent()) return;
      if (!response.ok) {
        if (response.status === 401) historyAuth = null;
        throw new Error(`History unavailable (${response.status}); sign in again to retry.`);
      }
      const page = await response.json();
      if (!isCurrent()) return;
      $('#info-content').innerHTML = `<p>Wallet ${escapeHtml(shortAddress(auth.address))}. Test credits have no real value. The contract is authoritative; a stored status is not a confirmed payment.</p><p id="history-status" role="status"></p><ol id="history-list"></ol><button id="history-refresh" class="button button-secondary" type="button">REFRESH</button>`;
      const list = $('#history-list');
      const pending = window.RageFridgeWallet.pendingTransaction(state.chainConfig) || state.chainPendingTx;
      if (pending) {
        $('#history-status').textContent = `Unconfirmed transaction: ${pending.hash}. Do not resubmit. This browser saves submitted hashes when local storage is available; always verify in your wallet too.`;
        const check = document.createElement('button');
        check.type = 'button'; check.className = 'button button-secondary'; check.textContent = 'CHECK PENDING TRANSACTION';
        check.addEventListener('click', async () => {
          check.disabled = true;
          try {
            const result = await window.RageFridgeWallet.receipt(state.chainConfig, pending.hash);
            if (!isCurrent()) return;
            if (!result.pending && state.chainPendingTx?.hash === pending.hash) state.chainPendingTx = null;
            $('#history-status').textContent = result.pending ? `Still pending: ${pending.hash}` : result.success ? `Confirmed: ${pending.hash}` : `Reverted: ${pending.hash}. No action completed.`;
          } catch (error) {
            if (isCurrent()) $('#history-status').textContent = error.message;
          } finally { check.disabled = false; }
        });
        $('#info-content').append(check);
      }
      if (!page.matches.length) list.insertAdjacentHTML('beforebegin', '<p>No recorded matches for this wallet on this server.</p>');
      for (const match of page.matches) {
        const item = document.createElement('li');
        const label = document.createElement('p');
        label.textContent = `${match.matchId} · ${match.state} · ${formatRFC(match.stake)} RFC stake`;
        const claim = document.createElement('button');
        claim.type = 'button';
        claim.className = 'button button-secondary';
        claim.textContent = 'CHECK / CLAIM';
        claim.addEventListener('click', () => { void claimFromHistory(match, claim); });
        item.append(label, claim);
        list.append(item);
      }
      $('#history-refresh').addEventListener('click', () => { void openHistory(offset); });
      if (page.nextOffset !== null) {
        const older = document.createElement('button');
        older.type = 'button'; older.className = 'button button-secondary'; older.textContent = 'OLDER MATCHES';
        older.addEventListener('click', () => { void openHistory(page.nextOffset); });
        $('#info-content').append(older);
      }
      if (offset > 0) {
        const newest = document.createElement('button');
        newest.type = 'button'; newest.className = 'button button-secondary'; newest.textContent = 'NEWEST MATCHES';
        newest.addEventListener('click', () => { void openHistory(0); });
        $('#info-content').append(newest);
      }
    } catch (error) {
      if (isCurrent()) {
        $('#info-content').textContent = error?.message || 'Could not load wallet history.';
        const retry = document.createElement('button');
        retry.type = 'button'; retry.className = 'button button-secondary'; retry.textContent = 'RETRY SIGN-IN';
        retry.addEventListener('click', () => { void openHistory(offset); });
        $('#info-content').append(retry);
      }
    } finally { historyLoading = false; }
  }

  async function claimFromHistory(match, button) {
    if (!historyAuth || state.chainTxBusy) return;
    const address = historyAuth.address;
    const generation = historyGeneration;
    const notice = (message) => { const status = $('#history-status'); if (status && generation === historyGeneration) status.textContent = message; };
    state.chainTxBusy = true;
    button.disabled = true;
    try {
      if (state.chainPendingTx) {
        const checked = await window.RageFridgeWallet.receipt(state.chainConfig, state.chainPendingTx.hash);
        if (checked.pending) throw new Error(`A transaction is still pending: ${state.chainPendingTx.hash}. Do not resubmit.`);
        state.chainPendingTx = null;
      }
      const progress = await window.RageFridgeWallet.inspect(state.chainConfig, match, address);
      if (generation !== historyGeneration || !historyAuth) return;
      if (progress.claimed) { notice('This match has already been claimed.'); return; }
      if (!['SETTLED', 'REFUNDABLE'].includes(progress.matchState)) {
        notice(`On-chain state: ${progress.matchState}. Claims wait for settlement or timeout/refund; refresh later.`);
        return;
      }
      if (!window.confirm(`Claim test-credit ${progress.matchState === 'REFUNDABLE' ? 'refund' : 'payout'} for ${match.matchId}? This is a Fuji transaction and requires test AVAX gas.`)) return;
      const result = await window.RageFridgeWallet.transact('claim', state.chainConfig, match, address, notice);
      if (result.pending) {
        state.chainPendingTx = { action: 'claim', hash: result.hash };
        notice(`Transaction pending: ${result.hash}. Check its receipt before retrying.`);
      } else notice(`Claim confirmed on Fuji: ${result.hash}`);
    } catch (error) { notice(error?.message || 'Claim failed; no payment is assumed.'); }
    finally { state.chainTxBusy = false; button.disabled = false; renderChain(state.latest); }
  }

  function renderLobby(room) {
    $('#room-code-display').textContent = room.code || '----';
    const players = Array.isArray(room.players) ? room.players : [];
    const seats = $('#lobby-seats');
    seats.innerHTML = '';
    players.forEach((player, index) => {
      const wallet = typeof player.wallet === 'string' ? `<small class="seat-wallet">${escapeHtml(shortAddress(player.wallet))}</small>` : '';
      const seatStatus = player.connected === false ? 'RECONNECTING' : room.mode === 'fuji' ? 'CONNECTED' : 'READY';
      seats.insertAdjacentHTML('beforeend', `<article class="seat-card ready"><img src="assets/cast.svg" alt="" class="seat-svg" data-seat="${index}"><span class="seat-number">SEAT 0${index + 1}</span><div><p class="seat-name">${escapeHtml(player.name || 'Kitchen guest')}</p><span class="seat-status">${seatStatus}</span>${wallet}</div>${player.bot ? '<span class="seat-bot">BOT DEMO</span>' : ''}</article>`);
    });
    for (let index = players.length; index < 4; index += 1) seats.insertAdjacentHTML('beforeend', `<article class="seat-card empty"><span class="seat-number">SEAT 0${index + 1}</span><div><p class="seat-name">OPEN SEAT</p><span class="seat-status">INVITE A PLAYER</span></div></article>`);
    $$('.seat-svg', seats).forEach((image, index) => { image.outerHTML = seatArt(index); });
    const count = players.length;
    const canStart = room.canStart === true;
    if (room.mode === 'fuji') {
      const deposited = Math.max(0, Math.min(4, Number(room.chain?.depositedCount) || 0));
      const ready = Math.max(0, Math.min(4, Number(room.chain?.readyCount) || 0));
      $('#ready-summary').textContent = count >= 4
        ? `${deposited}/4 test-credit deposits · ${ready}/4 confirmed ready`
        : `${count} of 4 seats filled — waiting for ${4 - count}`;
      const badge = $('.test-credit-badge');
      if (badge) badge.innerHTML = '<span>FUJI TEST CREDITS</span><b>NO REAL VALUE</b><small>Claims/refunds follow chain state</small>';
    } else {
      $('#ready-summary').textContent = count >= 4 ? 'All seats ready — host can start' : `${count} of 4 seats filled — waiting for ${4 - count}`;
      const badge = $('.test-credit-badge');
      if (badge) badge.innerHTML = '<span>FREE PROTOTYPE</span><b>NO PAYOUTS</b><small>Role and outcome weights only</small>';
    }
    $('#start-match').disabled = !canStart;
    if (room.demo) {
      $('#start-match').disabled = false;
      $('#ready-summary').textContent = 'Single-browser bot demo — all seats ready';
    }
  }
  function shortAddress(address) {
    return /^0x[0-9a-fA-F]{40}$/.test(address) ? `${address.slice(0, 6)}…${address.slice(-4)}` : 'Wallet seat';
  }
  function formatRFC(raw) {
    if (typeof raw !== 'string' || !/^\d+$/.test(raw)) return 'unknown';
    try {
      const formatted = window.ethers?.formatUnits ? window.ethers.formatUnits(BigInt(raw), 18) : raw;
      return formatted.includes('.') ? formatted.replace(/0+$/, '').replace(/\.$/, '') : formatted;
    } catch (_) { return raw; }
  }
  function renderChain(room = state.latest) {
    const panel = $('#chain-panel');
    const chain = room?.chain;
    if (!chain) {
      panel.classList.add('is-hidden');
      return;
    }
    panel.classList.remove('is-hidden');
    const roomState = String(chain.state || 'CREATING').toUpperCase();
    const stake = formatRFC(chain.stake);
    $('#chain-panel-title').textContent = room.phase === 'ended' ? 'Match chain status' : 'Test-credit lobby';
    const deposits = Math.max(0, Math.min(4, Number(chain.depositedCount) || 0));
    const ready = Math.max(0, Math.min(4, Number(chain.readyCount) || 0));
    $('#chain-summary').textContent = `${roomState.replaceAll('_', ' ')} · ${stake === 'unknown' ? 'test-credit stake not yet available' : `${stake} RFC test-credit stake`} · deposits ${deposits}/4 · ready ${ready}/4 · Avalanche Fuji · chain 43113`;
    $('#chain-error').textContent = state.chainError || chain.error || '';
    $('#chain-tx-status').textContent = state.chainMessage || (state.chainPendingTx
      ? `Unconfirmed wallet transaction: ${state.chainPendingTx.hash}. Check its receipt before retrying.`
      : chain.txHash ? `Latest chain transaction: ${chain.txHash}` : '');
    ['reauth', 'mint', 'approve', 'deposit', 'ready', 'claim'].forEach((name) => {
      const button = $(`#chain-${name}`);
      button.classList.add('is-hidden');
      button.disabled = state.chainTxBusy || Boolean(state.chainPendingTx);
    });
    if (!state.walletAddressBound) {
      $('#chain-error').textContent = 'This wallet seat is not authenticated in this page. Leave and rejoin with the Fuji test-room option enabled.';
      return;
    }
    if (state.walletBindingInvalid) {
      $('#chain-error').textContent = 'Wallet account or network changed. Re-authenticate with the same EOA before continuing; another wallet cannot use this seat.';
      $('#chain-reauth').classList.remove('is-hidden');
      $('#chain-reauth').disabled = state.chainTxBusy;
      return;
    }
    if (!window.RageFridgeWallet || !state.chainConfig?.enabled) {
      $('#chain-error').textContent = 'Fuji wallet support is unavailable on this page. Do not send transactions from another interface using room data.';
      return;
    }
    if (!chain.matchId || !state.chainProgress || state.chainInspecting) return;
    const progress = state.chainProgress;
    const isFunding = room.phase === 'lobby' && progress.matchState === 'FUNDING';
    const busy = state.chainTxBusy || Boolean(state.chainPendingTx);
    if (progress.seatIndex >= 0 && ['SETTLED', 'REFUNDABLE'].includes(progress.matchState) && !progress.claimed) {
      $('#chain-claim').classList.remove('is-hidden');
      $('#chain-claim').disabled = busy;
      $('#chain-claim').textContent = progress.matchState === 'REFUNDABLE' ? 'CLAIM TEST-CREDIT REFUND' : 'CLAIM TEST-CREDIT RESULT';
      $('#chain-tx-status').textContent = state.chainMessage || `Connected EOA ${shortAddress(progress.address)} · claim is a separate wallet transaction.`;
    } else if (isFunding && progress.seatIndex >= 0) {
      if (!progress.deposited && progress.balance < progress.stake) $('#chain-mint').classList.remove('is-hidden');
      else if (!progress.deposited && progress.allowance !== progress.stake) $('#chain-approve').classList.remove('is-hidden');
      else if (!progress.deposited) $('#chain-deposit').classList.remove('is-hidden');
      else if (!progress.ready) $('#chain-ready').classList.remove('is-hidden');
      $('#chain-tx-status').textContent = state.chainMessage || `Connected EOA ${shortAddress(progress.address)} · exact allowance only · no server custody.`;
    } else if (progress.seatIndex < 0) {
      $('#chain-error').textContent = 'The connected EOA is not listed as a recipient for this match. No transaction is available.';
    } else if (progress.matchState === 'RESULT_PENDING') {
      const end = Number(progress.inspectionEnds) || Number(chain.inspectionEnds);
      $('#chain-tx-status').textContent = `Result inspection is in progress${end ? ` until ${new Date(end * 1000).toLocaleTimeString()}` : ''}. Claims are unavailable until the on-chain state is terminal.`;
    } else if (progress.matchState === 'FUNDING' && progress.seatIndex >= 0 && room.phase !== 'lobby') {
      $('#chain-tx-status').textContent = 'The on-chain match is still funding; the game server has not opened gameplay.';
    }
  }
  async function refreshChainProgress(force = false) {
    const room = state.latest;
    const chain = room?.chain;
    const address = state.walletAddressBound;
    if (!chain || !chain.matchId || !address || state.walletBindingInvalid || !state.chainConfig?.enabled || !window.RageFridgeWallet) {
      state.chainProgress = null;
      state.chainProgressKey = '';
      renderChain(room);
      return;
    }
    const key = `${chain.matchId}:${address.toLowerCase()}`;
    if (!force && state.chainProgressKey === key && Date.now() - state.chainProgressAt < 5_000) {
      renderChain(room);
      return;
    }
    if (state.chainInspecting) return;
    state.chainInspecting = true;
    state.chainProgressKey = key;
    renderChain(room);
    try {
      const progress = await window.RageFridgeWallet.inspect(state.chainConfig, chain, address);
      if (state.latest?.chain?.matchId === chain.matchId && state.walletAddressBound?.toLowerCase() === address.toLowerCase() && !state.walletBindingInvalid) {
        state.chainProgress = progress;
        state.chainError = '';
        state.chainProgressAt = Date.now();
        if (state.chainPendingTx) {
          const checked = await window.RageFridgeWallet.receipt(state.chainConfig, state.chainPendingTx.hash);
          if (!checked.pending) {
            state.chainPendingTx = null;
            state.chainMessage = checked.success ? 'Transaction confirmed on Fuji.' : 'Transaction reverted on Fuji.';
          }
        }
      }
    } catch (error) {
      if (state.latest?.chain?.matchId === chain.matchId) {
        state.chainProgress = null;
        state.chainError = error?.message || 'Could not read Fuji match status.';
      }
    } finally {
      state.chainInspecting = false;
      renderChain(state.latest);
    }
  }
  async function reauthenticateRoomWallet() {
    if (!state.chainConfig?.enabled || !state.walletAddressBound || state.chainTxBusy) return;
    state.chainTxBusy = true;
    renderChain(state.latest);
    try {
      const auth = await window.RageFridgeWallet.authenticate(state.chainConfig);
      if (auth.address.toLowerCase() !== state.walletAddressBound.toLowerCase()) {
        window.RageFridgeWallet.clearAuthentication();
        throw new Error('The wallet must be the same EOA that joined this seat.');
      }
      state.walletAuth = auth;
      state.walletBindingInvalid = false;
      state.chainProgress = null;
      state.chainProgressAt = 0;
      state.chainMessage = 'Wallet re-authenticated. Fuji state is being refreshed.';
      await refreshChainProgress(true);
    } catch (error) {
      state.walletAuth = null;
      state.walletBindingInvalid = true;
      state.chainError = error?.message || 'Wallet re-authentication failed.';
    } finally {
      state.chainTxBusy = false;
      renderChain(state.latest);
    }
  }
  async function runChainAction(action) {
    const chain = state.latest?.chain;
    const address = state.walletAddressBound;
    if (!chain || !address || state.walletBindingInvalid || state.chainTxBusy || state.chainPendingTx) return;
    state.chainTxBusy = true;
    state.chainMessage = '';
    state.chainError = '';
    $('#chain-error').textContent = '';
    renderChain(state.latest);
    try {
      const result = await window.RageFridgeWallet.transact(action, state.chainConfig, chain, address, (message) => {
        state.chainMessage = message;
        $('#chain-tx-status').textContent = message;
      });
      if (result.pending) {
        state.chainPendingTx = { action, hash: result.hash };
        state.chainMessage = `${result.reason || 'Transaction is still pending.'} Check transaction ${result.hash}; do not submit it again.`;
      } else {
        state.chainMessage = `Confirmed on Fuji · ${result.hash}`;
        await refreshChainProgress(true);
      }
    } catch (error) {
      state.chainMessage = '';
      state.chainError = error?.message || 'Wallet transaction failed or was cancelled. No success is assumed.';
    } finally {
      state.chainTxBusy = false;
      renderChain(state.latest);
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
    const resultNote = $('.conservation small');
    if (resultNote) resultNote.textContent = room.chain
      ? 'Fuji test-credit custody is separate; use the chain panel above to check or claim it.'
      : 'No payout, settlement, custody, or wallet is connected.';
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
  $('#open-history').addEventListener('click', () => { void openHistory(); });
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
  $('#chain-reauth').addEventListener('click', () => { void reauthenticateRoomWallet(); });
  ['mint', 'approve', 'deposit', 'ready', 'claim'].forEach((action) => {
    $(`#chain-${action}`).addEventListener('click', () => { void runChainAction(action); });
  });
  window.addEventListener('ragewallet:invalidated', (event) => {
    historyAuth = null;
    historyGeneration++;
    if ($('#info-kicker').textContent === 'PRIVATE WALLET HISTORY' && !$('#info-dialog').classList.contains('is-hidden')) {
      $('#info-content').textContent = 'Wallet identity changed. Close and reopen history to sign in again.';
    }
    if (!state.walletAddressBound) return;
    state.walletAuth = null;
    state.walletBindingInvalid = true;
    state.chainProgress = null;
    state.chainError = event.detail?.reason || 'Wallet identity changed. Re-authenticate before continuing.';
    renderChain(state.latest);
  });
  $('#safety-stop').addEventListener('click', () => {
    const paidRoom = state.latest?.mode === 'fuji';
    const prompt = paidRoom
      ? 'Safety Stop voids the game and starts the Fuji test-credit refund path. Refund claims wait for chain state; no winner payout is awarded. Continue?'
      : 'Safety Stop ends this room in a technical void. No score, payout, or settlement is created. Continue?';
    if (window.confirm(prompt)) send({ type: 'stop' });
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
  window.addEventListener('blur', concealRole);
  document.addEventListener('visibilitychange', () => { if (document.hidden) concealRole(); });
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
  void loadChainConfig();
})();
