const roast = Object.freeze({
  1: Object.freeze({ temperature: -2, speakerBP: 4, targetBP: 2, text: 'Your timer is just a clock with stage fright.' }),
  2: Object.freeze({ temperature: -4, speakerBP: 7, targetBP: 4, text: 'That soufflé saw your recipe and chose to lie down.' }),
  3: Object.freeze({ temperature: -6, speakerBP: 11, targetBP: 6, text: 'Your signature dish is the smoke alarm’s greatest hit.' }),
});

export const rules = Object.freeze({
  version: '0.1-authored', seats: 4, roleSeconds: 10, duration: 300, suddenDeathAt: 270,
  startingTemperature: 20, temperatureFloor: -30, coldThreshold: -10, holdSeconds: 10,
  overheatThreshold: 100, ambientHeat: 0.2, suddenDeathHeat: 0.4, eventCap: 6,
  scoredCooldown: 6, pairWindow: 12, pairMultiplier: 0.5, targetWindow: 10, targetCap: 2,
  duplicateWindow: 30, textLimit: 180, lastSubmission: 298, disconnectGrace: 15,
  startingBP: 10, maxBP: 100, passiveDelay: 3, passiveRecovery: 0.5,
  restCooldown: 18, restSeconds: 4, restRecovery: 3,
  deflectCooldown: 12, deflectSeconds: 3, deflectMultiplier: 0.5,
  stoicMaxBP: 20, stoicMinimum: 6, composedMaxBP: 50,
  roast, compliment: Object.freeze({ temperature: 2, speakerBP: 1, targetBP: -3 }),
});

export const ROLES = Object.freeze(['chef', 'chef', 'saboteur', 'stoic']);
export const BOT_NAMES = Object.freeze(['Whisk (Bot)', 'Skillet (Bot)', 'Kettle (Bot)']);
const ACTIVE_PHASES = new Set(['active', 'suddenDeath']);
const units = (value) => Math.round(value * 100);
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const bpBand = (player) => {
  if (!player.alive) return 'eliminated';
  if (player.bp >= 9000) return 'critical';
  if (player.bp >= 7500) return 'danger';
  if (player.bp >= 5000) return 'simmering';
  if (player.bp > 2000) return 'active';
  return 'calm';
};

export class Game {
  constructor(code, demo = false) {
    this.code = code;
    this.demo = demo;
    this.players = [];
    this.hostId = null;
    this.phase = 'lobby';
    this.roleRemaining = 0;
    this.temperature = units(rules.startingTemperature);
    this.elapsed = 0;
    this.coldHold = 0;
    this.events = [];
    this.queue = [];
    this.totalReceipts = 0;
    this.outcome = null;
  }

  addPlayer(id, name, bot = false) {
    if (this.phase !== 'lobby' || this.players.length >= rules.seats) return null;
    const player = {
      id, name, bot, role: null, connected: true, disconnectedAt: null, alive: true,
      bp: units(rules.startingBP), peakBP: units(rules.startingBP), lastIncrease: 0,
      scoredReady: 0, restReady: 0, restUntil: 0, deflectReady: 0, shieldUntil: 0,
      pending: false, pairs: new Map(), lines: new Map(), incoming: [], receipts: 0,
    };
    this.players.push(player);
    if (!bot) this.hostId ??= id;
    return player;
  }

  getPlayer(id) {
    return this.players.find((player) => player.id === id);
  }

  canStart() {
    return this.phase === 'lobby' && this.players.length === rules.seats &&
      this.players.every((player) => player.connected);
  }

  start(id, roles) {
    if (id !== this.hostId) return 'Only the host can start the match.';
    if (!this.canStart()) return 'The lobby needs four connected seats before it can start.';
    this.players.forEach((player, i) => { player.role = roles[i]; });
    this.phase = 'roles';
    this.roleRemaining = rules.roleSeconds;
    this.record('roles', 'Private roles dealt. The kitchen opens in ten seconds.');
    return null;
  }

  disconnect(id, now) {
    const player = this.getPlayer(id);
    if (!player) return;
    if (this.phase === 'lobby') {
      this.players = this.players.filter((seat) => seat !== player);
      if (id === this.hostId) this.hostId = this.players.find((seat) => !seat.bot)?.id ?? null;
    } else {
      player.connected = false;
      player.disconnectedAt = now;
    }
  }

  reconnect(id, now) {
    const player = this.getPlayer(id);
    if (!player || player.connected || this.phase === 'lobby') return false;
    if (this.phase !== 'ended' && now - player.disconnectedAt > rules.disconnectGrace * 1000) {
      this.eliminate(player, 'disconnect');
    }
    player.connected = true;
    player.disconnectedAt = null;
    return true;
  }

  record(type, text, details = {}) {
    this.events.push({ id: this.events.length + 1, at: this.elapsed, type, text, ...details });
  }

  eliminate(player, reason) {
    if (!player.alive) return;
    player.alive = false;
    this.record('eliminated', `${player.name} ${reason === 'disconnect' ? 'lost their connection and is out' : 'popped at 100 BP'}!`, {
      actor: player.id, reason,
    });
  }

  changeBP(player, amount) {
    if (!player.alive) return;
    player.bp = clamp(player.bp + amount, 0, units(rules.maxBP));
    if (amount > 0) this.players.includes(player) && (player.lastIncrease = this.elapsed);
    player.peakBP = Math.max(player.peakBP, player.bp);
    if (player.bp >= units(rules.maxBP)) this.eliminate(player, 'bp');
  }

  submit(id, message) {
    if (!ACTIVE_PHASES.has(this.phase)) return 'Actions are only available during active play.';
    const player = this.getPlayer(id);
    if (!player?.alive || !player.connected) return 'This seat cannot act.';
    const t = this.elapsed;
    switch (message.action) {
      case 'rest': {
        if (player.pending) return 'Wait for your pending action before resting.';
        if (t < player.restReady) return 'Rest is on cooldown.';
        player.restReady = t + rules.restCooldown;
        player.restUntil = t + rules.restSeconds;
        this.record('rest', `${player.name} takes a sip of water.`, { actor: id });
        return null;
      }
      case 'deflect': {
        if (message.target != null && message.target !== id) return 'Deflect only protects your own seat.';
        if (t < player.deflectReady) return 'Deflect is on cooldown.';
        player.deflectReady = t + rules.deflectCooldown;
        player.shieldUntil = t + rules.deflectSeconds;
        this.record('deflect', `${player.name} raises a pan shield.`, { actor: id });
        return null;
      }
      case 'roast':
      case 'compliment': {
        if (t >= rules.lastSubmission) return 'It is too late to submit a scored action.';
        if (t < player.restUntil) return 'You cannot roast or compliment while resting.';
        if (player.pending || t < player.scoredReady) return 'Your scored action is on cooldown.';
        const target = this.getPlayer(message.target);
        if (!target?.alive || !target.connected || target === player) return 'Choose another living connected player to target.';
        const tier = message.tier ?? 1;
        if (message.action === 'roast' && (!Number.isInteger(tier) || tier < 1 || tier > 3)) {
          return 'Choose a roast tier from 1 to 3.';
        }
        if (message.text != null && (typeof message.text !== 'string' || Array.from(message.text).length > rules.textLimit)) {
          return `Text must be at most ${rules.textLimit} characters.`;
        }
        // Authored-only play: no unmoderated lines are scored, retained, or broadcast.
        const ungraded = Boolean(message.text?.trim());
        player.scoredReady = t + rules.scoredCooldown;
        player.pending = true;
        this.queue.push({ action: message.action, tier, player, target, ungraded });
        return null;
      }
      default:
        return 'Unknown action.';
    }
  }

  resolve({ action, tier, player, target, ungraded }) {
    const actor = player.id;
    const details = { actor, target: target.id };
    if (ungraded) {
      this.record('ungraded', 'Free text is ungraded in authored-only play. Use a canned action.', details);
      return 0;
    }
    if (action === 'compliment') {
      const { temperature, speakerBP, targetBP } = rules.compliment;
      this.changeBP(player, units(speakerBP));
      this.changeBP(target, units(targetBP));
      this.record(action, 'The kitchen is lucky to have your steady whisk.', { ...details, delta: temperature });
      return units(temperature);
    }
    const t = this.elapsed;
    const line = rules.roast[tier];
    const duplicate = t - (player.lines.get(tier) ?? -Infinity) < rules.duplicateWindow;
    const repeat = t - (player.pairs.get(target.id) ?? -Infinity) < rules.pairWindow;
    player.lines.set(tier, t);
    player.pairs.set(target.id, t);
    target.incoming = target.incoming.filter((at) => t - at < rules.targetWindow);
    this.changeBP(player, units(line.speakerBP));
    const reason = duplicate ? 'duplicate' : target.incoming.length >= rules.targetCap ? 'protected' : null;
    if (reason) {
      this.record(action, reason === 'duplicate' ? 'Repeat line: no cooling or target BP.' : 'Target protected: no cooling or target BP.', {
        ...details, tier, delta: 0, reason,
      });
      return 0;
    }
    const multiplier = repeat ? rules.pairMultiplier : 1;
    const temperature = line.temperature * multiplier;
    // An already accepted action cools even if a prior event eliminated its target.
    // An eliminated target cannot receive BP, consume a shield, or earn objective credit.
    let deflected = false;
    if (target.alive) {
      target.incoming.push(t);
      target.receipts++;
      this.totalReceipts++;
      deflected = target.shieldUntil >= t;
      if (deflected) target.shieldUntil = 0;
      this.changeBP(target, units(line.targetBP * multiplier * (deflected ? rules.deflectMultiplier : 1)));
    }
    this.record(action, line.text, { ...details, tier, delta: temperature, repeat, deflected });
    return units(temperature);
  }

  tick(now) {
    if (this.phase === 'lobby' || this.phase === 'ended') return;
    for (const player of this.players) {
      if (!player.connected && now - player.disconnectedAt > rules.disconnectGrace * 1000) {
        this.eliminate(player, 'disconnect');
      }
    }
    if (this.phase === 'roles') {
      if (--this.roleRemaining === 0) {
        this.phase = 'active';
        this.record('start', 'The kitchen is open!');
      }
      return;
    }
    if (this.demo) this.actAsBots();
    const suddenDeath = this.elapsed >= rules.suddenDeathAt;
    this.elapsed++;
    const t = this.elapsed;
    for (const player of this.players) {
      if (player.shieldUntil < t) player.shieldUntil = 0;
      const passive = t - player.lastIncrease >= rules.passiveDelay ? units(rules.passiveRecovery) : 0;
      const rest = t <= player.restUntil ? units(rules.restRecovery) : 0;
      this.changeBP(player, -(passive + rest));
    }
    let delta = 0;
    for (const entry of this.queue) {
      entry.player.pending = false;
      delta += this.resolve(entry);
    }
    this.queue = [];
    const ambient = suddenDeath ? rules.suddenDeathHeat : rules.ambientHeat;
    const cap = units(rules.eventCap);
    this.temperature = clamp(this.temperature + units(ambient) + clamp(delta, -cap, cap),
      units(rules.temperatureFloor), units(rules.overheatThreshold));
    if (this.temperature >= units(rules.overheatThreshold)) {
      const alive = this.players.some((player) => player.role === 'saboteur' && player.alive);
      this.finish(alive ? 'sabotage' : 'draw', alive ? 'overheat' : 'saboteurEliminated');
    } else if (!this.players.some((player) => player.role !== 'saboteur' && player.alive)) {
      this.finish('draw', 'coldTeamEliminated');
    } else {
      this.coldHold = this.temperature <= units(rules.coldThreshold) ? this.coldHold + 1 : 0;
      if (t === rules.duration) {
        const held = this.coldHold >= rules.holdSeconds;
        this.finish(held ? 'cold' : 'draw', held ? 'coldHold' : 'missedColdHold');
      } else if (t === rules.suddenDeathAt) {
        this.phase = 'suddenDeath';
        this.record('suddenDeath', 'Sudden Death: ambient heat has doubled.');
      }
    }
  }

  actAsBots() {
    const t = this.elapsed;
    for (const [index, bot] of this.players.entries()) {
      if (!bot.bot || !bot.alive) continue;
      if (bot.bp >= 2800 && t >= bot.restReady) {
        this.submit(bot.id, { action: 'rest' });
        continue;
      }
      if (bot.role === 'stoic' && bot.incoming.length && t >= bot.deflectReady) {
        this.submit(bot.id, { action: 'deflect' });
      }
      // Stagger bots so they do not all spend actions against the same per-tick cap.
      const interval = bot.role === 'saboteur' ? 12 : 15;
      const offset = index * 3;
      if (t < offset || (t - offset) % interval !== 0) continue;
      const turn = (t - offset) / interval;
      const targets = this.players.filter((seat) => seat !== bot && seat.alive && seat.connected);
      if (!targets.length) continue;
      const target = targets[(turn + index) % targets.length];
      if (bot.role === 'saboteur') this.submit(bot.id, { action: 'compliment', target: target.id });
      else {
        const tiers = bot.role === 'stoic' ? [1, 2, 1, 3] : [2, 3, 1];
        this.submit(bot.id, { action: 'roast', target: target.id, tier: tiers[turn % tiers.length] });
      }
    }
  }

  finish(type, reason) {
    if (this.phase === 'ended') return;
    this.phase = 'ended';
    this.roleRemaining = 0;
    this.queue = [];
    this.outcome = {
      type, reason, totalReceipts: this.totalReceipts,
      players: this.players.map((player) => {
        player.pending = false;
        const composed = player.peakBP <= units(rules.composedMaxBP);
        const stoicBonus = player.role === 'stoic' && player.receipts >= rules.stoicMinimum &&
          player.receipts * 2 > this.totalReceipts && player.peakBP <= units(rules.stoicMaxBP);
        let weight = 0;
        if (player.alive && type === 'cold' && player.role !== 'saboteur') weight = stoicBonus ? 200 : composed ? 125 : 100;
        if (player.alive && type === 'sabotage' && player.role === 'saboteur') weight = 100;
        return { id: player.id, role: player.role, alive: player.alive, weight, peakBP: player.peakBP / 100,
          receipts: player.receipts, stoicBonus: weight === 200 };
      }),
    };
    const captions = { cold: 'Cold team wins! The Wagyu is saved.', sabotage: 'The fridge overheats! The Saboteur wins.',
      draw: 'No winner this time.', void: reason === 'safetyStop' ? 'Match stopped for safety.' : 'Match voided: server timing interrupted.' };
    this.record('result', captions[type], { reason });
  }

  snapshot(id) {
    const player = this.getPlayer(id);
    const t = this.elapsed;
    const live = ACTIVE_PHASES.has(this.phase);
    const remaining = (deadline) => live ? Math.max(0, deadline - t) : 0;
    const you = {
      id, bp: player.bp / 100, role: player.role, alive: player.alive, bpBand: bpBand(player),
      cooldown: remaining(player.scoredReady), restCooldown: remaining(player.restReady),
      deflectCooldown: remaining(player.deflectReady), resting: remaining(player.restUntil),
      deflecting: remaining(player.shieldUntil), pending: player.pending,
    };
    if (player.role === 'stoic') {
      you.receipts = player.receipts;
      you.stoicPeakOK = player.peakBP <= units(rules.stoicMaxBP);
    }
    return {
      code: this.code, phase: this.phase, demo: this.demo, mode: this.demo ? 'demo' : 'free',
      hostId: this.hostId, canStart: id === this.hostId && this.canStart(),
      players: this.players.map((seat) => ({
        id: seat.id, name: seat.name, alive: seat.alive, bpBand: bpBand(seat), bot: seat.bot, connected: seat.connected,
        protected: seat.incoming.filter((at) => t + 1 - at < rules.targetWindow).length >= rules.targetCap,
        ...(this.phase === 'ended' ? { role: seat.role } : {}),
      })),
      you, temperature: this.temperature / 100, elapsed: t,
      remaining: rules.duration - t, roleRemaining: this.roleRemaining,
      coldHold: Math.min(this.coldHold, rules.holdSeconds),
      events: this.events.slice(-20), outcome: this.outcome, rules,
    };
  }
}
