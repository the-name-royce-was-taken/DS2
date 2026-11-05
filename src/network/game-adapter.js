import { decodeState, encodeState } from './protocol.js';

const REMOTE_RENDER_DELAY = 100;
const MAX_EXTRAPOLATION = 120;

function finite(value, fallback = 0) {
  return Number.isFinite(Number(value)) ? Number(value) : fallback;
}

function distance3(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

function angleLerp(a, b, amount) {
  let delta = ((b - a + Math.PI) % (Math.PI * 2)) - Math.PI;
  return a + delta * amount;
}

function isNewerSequence(next, previous) {
  if (!Number.isFinite(previous) || previous < 0) return true;
  const delta = (Number(next) - Number(previous)) >>> 0;
  return delta !== 0 && delta < 0x80000000;
}

export class VeraGameAdapter {
  constructor() {
    this.game = null;
    this.active = false;
    this.role = '';
    this.slot = 0;
    this.remote = null;
    this.remotes = new Map();
    this.remotePlayers = new Map();
    this.remoteTeam = '';
    this.remoteTeamOverride = '';
    this.remoteBuffer = [];
    this.remoteBuffers = new Map();
    this.remoteLastSequence = -1;
    this.remoteLastSequences = new Map();
    this.remoteRelaySequences = new Map();
    this.remoteLastState = null;
    this.authoritativeLocalSequence = -1;
    this.remoteLastStates = new Map();
    this.localSequence = 0;
    this.stateSequence = 0;
    this.tick = 0;
    this.suppressNetwork = false;
    this.originalSetup = null;
    this.originalFireBullet = null;
    this.originalPlayerMelee = null;
    this.originalRemote = null;
    this.remoteOriginals = new Map();
    this.onLocalShot = () => {};
    this.onStatus = () => {};
    this.frameHandle = 0;
    this.lastFrameAt = 0;
    this.lastRemoteClaimAt = 0;
    this.botConstructor = null;
    this.botDifficulty = 2;
    this.diagTimes = new Map();
    this.diagnosticsEnabled = false;
  }

  setDiagnosticsEnabled(enabled) {
    this.diagnosticsEnabled = !!enabled;
  }

  diagnostic(key, ...details) {
    if (!this.diagnosticsEnabled) return;
    const now = performance.now();
    const previous = this.diagTimes.get(key) || 0;
    if (now - previous < 3000) return;
    this.diagTimes.set(key, now);
    console.log('[VERA][adapter]', key, ...details);
  }

  activate(role, slot) {
    this.game = window.game || null;
    this.active = true;
    this.role = role === 'guest' ? 'guest' : 'host';
    this.slot = Number.isInteger(Number(slot)) ? Math.max(0, Math.min(31, Number(slot))) : 0;
    this.remoteTeamOverride = '';
    this.remotes.clear();
    this.remotePlayers.clear();
    this.remoteBuffers.clear();
    this.remoteLastSequences.clear();
    this.remoteRelaySequences.clear();
    this.remoteLastState = null;
    this.remoteLastStates.clear();
    this.authoritativeLocalSequence = -1;
    this.lastRemoteClaimAt = 0;
    this.remoteBuffer.length = 0;
    this.remoteLastSequence = -1;
    this.ensureHooks();
    this.diagnostic('activate', { role: this.role, slot: this.slot, game: !!this.game, botManager: !!(this.game && this.game.botMgr) });
    this.startFrameLoop();
  }

  ensureHooks() {
    const game = this.game || window.game;
    if (!game) return false;
    this.game = game;
    const manager = game.botMgr;
    if (manager && !manager.__veraNetworkSetup) {
      this.originalSetup = manager.setup;
      const adapter = this;
      manager.setup = function veraNetworkSetup() {
        const result = adapter.originalSetup.apply(this, arguments);
        const template = this.bots && this.bots[0];
        if (template) {
          adapter.botConstructor = template.constructor;
          adapter.botDifficulty = finite(template.difficulty, adapter.botDifficulty);
        }
        if (adapter.active) adapter.claimRemoteSlots();
        return result;
      };
      manager.__veraNetworkSetup = true;
    }
    if (!game.__veraNetworkMeleeHook && typeof game.playerMelee === 'function') {
      this.originalPlayerMelee = game.playerMelee;
      const adapter = this;
      game.playerMelee = function veraNetworkPlayerMelee(damage, weapon, backDamage, heavy) {
        const result = adapter.originalPlayerMelee.apply(this, arguments);
        if (adapter.active && !adapter.suppressNetwork && weapon && weapon.class === 'knife') {
          const player = adapter.game && adapter.game.player;
          const yaw = finite(player && player.yaw);
          const pitch = finite(player && player.pitch);
          const cp = Math.cos(pitch);
          adapter.onLocalShot({
            type: 'melee',
            eventId: `${adapter.slot}:${adapter.localSequence++}`,
            tick: adapter.tick,
            weapon: 'knife',
            x: finite(player && player.x),
            y: finite(player && player.y),
            z: finite(player && player.z),
            damage: finite(damage),
            backDamage: finite(backDamage),
            heavy: !!heavy,
            dirX: -Math.sin(yaw) * cp,
            dirY: Math.sin(pitch),
            dirZ: -Math.cos(yaw) * cp
          });
        }
        return result;
      };
      game.__veraNetworkMeleeHook = true;
    }
    if (!game.__veraNetworkFireHook && typeof game.fireBullet === 'function') {
      this.originalFireBullet = game.fireBullet;
      const adapter = this;
      game.fireBullet = function veraNetworkFireBullet(shooter, x, y, z, dx, dy, dz, weapon) {
        const result = adapter.originalFireBullet.apply(this, arguments);
        if (adapter.active && !adapter.suppressNetwork && shooter === adapter.game.player && weapon) {
          adapter.onLocalShot({
            type: 'fire',
            eventId: `${adapter.slot}:${adapter.localSequence++}`,
            tick: adapter.tick,
            weapon: String(weapon.id || adapter.game.weapons.current || 'knife'),
            ox: finite(x), oy: finite(y), oz: finite(z),
            dx: finite(dx), dy: finite(dy), dz: finite(dz)
          });
        }
        return result;
      };
      game.__veraNetworkFireHook = true;
    }
    return true;
  }

  async startMatch({ map, mode, team }) {
    if (!this.active) throw new Error('Multiplayer adapter is not active.');
    this.ensureHooks();
    const game = this.game || window.game;
    if (!game || typeof game.startGame !== 'function' || typeof game.finishTeamSelect !== 'function') {
      throw new Error('The current game build does not expose its match entry points.');
    }
    this.game = game;
    const remoteBotCount = Math.max(1, this.remotePlayers.size);
    await game.startGame(map, remoteBotCount, 1, mode || 'defusal');
    this.ensureHooks();
    await game.finishTeamSelect(team || (this.slot === 0 ? 'CT' : 'T'));
    this.claimRemoteSlots();
    this.onStatus('match-ready');
  }

  selectedMatch() {
    const menu = document.querySelector('#menu');
    const value = selector => {
      const selected = menu && menu.querySelector(`${selector} .sel`);
      return selected && selected.dataset ? selected.dataset.v : '';
    };
    return {
      map: value('#opt-map') || 'oasis',
      mode: value('#opt-mode') || 'defusal'
    };
  }

  setRemotePlayers(players = []) {
    this.remotePlayers.clear();
    for (const player of players) {
      const slot = Number(player && player.slot);
      if (!Number.isInteger(slot) || slot < 0 || slot > 31 || slot === this.slot) continue;
      this.remotePlayers.set(slot, player.team === 'CT' || player.team === 'T' ? player.team : '');
    }
    this.diagnostic('roster', { role: this.role, localSlot: this.slot, slots: [...this.remotePlayers.keys()], teams: [...this.remotePlayers.entries()] });
    this.claimRemoteSlots();
  }

  claimRemoteSlots() {
    for (const [slot, remoteTeam] of this.remotePlayers) this.claimRemoteSlot(slot, remoteTeam);
    return this.remote || null;
  }

  claimRemoteSlot(slot = 1, remoteTeam = '') {
    const manager = this.game && this.game.botMgr;
    if (!manager) {
      this.diagnostic('claim-no-manager', { slot, game: !!this.game });
      return null;
    }
    const normalizedSlot = Number(slot);
    if (this.remotes.has(normalizedSlot)) {
      const existing = this.remotes.get(normalizedSlot);
      if (remoteTeam === 'CT' || remoteTeam === 'T') {
        existing.__veraTeam = remoteTeam;
        existing.team = remoteTeam;
        this.remoteTeam = remoteTeam;
      }
      return existing;
    }
    let candidate = manager.bots && manager.bots.find(bot => !bot.__veraRemote);
    let created = false;
    if (!candidate) {
      const template = manager.bots && manager.bots[0];
      const Bot = this.botConstructor || (template && template.constructor);
      if (typeof Bot !== 'function') {
        this.diagnostic('claim-no-bot-constructor', { slot: normalizedSlot, botCount: manager.bots && manager.bots.length });
        return null;
      }
      const localTeam = this.game && this.game.player && this.game.player.team;
      const botTeam = remoteTeam === 'CT' || remoteTeam === 'T'
        ? remoteTeam
        : (this.remoteTeamOverride || (localTeam === 'CT' ? 'T' : 'CT'));
      const difficulty = template ? template.difficulty : this.botDifficulty;
      candidate = new Bot(this.game, botTeam, `Player ${normalizedSlot}`, difficulty);
      manager.bots.push(candidate);
      this.botConstructor = Bot;
      this.botDifficulty = finite(difficulty, this.botDifficulty);
      created = true;
      this.diagnostic('remote-bot-created', { remoteSlot: normalizedSlot, team: botTeam, botCount: manager.bots.length });
    }
    this.diagnostic('player-to-bot-mapped', { remoteSlot: normalizedSlot, botName: candidate.name, botAlive: candidate.alive, botCount: manager.bots && manager.bots.length, created });
    const original = {
      update: candidate.update,
      spawn: candidate.spawn,
      die: candidate.die,
      body: candidate._updateCS2Body
    };
    this.remoteOriginals.set(normalizedSlot, original);
    this.remotes.set(normalizedSlot, candidate);
    this.remote = this.remotes.get(1) || candidate;
    this.remoteTeam = (remoteTeam === 'CT' || remoteTeam === 'T')
      ? remoteTeam
      : (this.remoteTeamOverride || (candidate.team === 'CT' ? 'CT' : 'T'));
    candidate.__veraRemoteSlot = normalizedSlot;
    candidate.__veraTeam = this.remoteTeam;
    candidate.team = this.remoteTeam;
    candidate.__veraRemote = true;
    // Keep the engine's bot/entity damage path for this slot. Marking it as
    // `isPlayer` would make the existing kill handler drop the local player's
    // inventory when a remote client dies.
    candidate.__veraRemotePlayer = true;
    candidate.name = `Player ${normalizedSlot}`;
    const adapter = this;
    candidate.update = function veraRemoteUpdate(delta) { adapter.updateRemoteEntity(this, delta); };
    candidate.spawn = function veraRemoteSpawn() { return adapter.spawnRemoteEntity(this); };
    candidate.__veraNetworkOriginal = original;
    if (created && typeof original.spawn === 'function') this.spawnRemoteEntity(candidate);
    return candidate;
  }

  spawnRemoteEntity(remote) {
    const slot = Number(remote && remote.__veraRemoteSlot);
    const originalSpawn = this.remoteOriginals.get(slot) && this.remoteOriginals.get(slot).spawn;
    if (originalSpawn) {
      try {
        originalSpawn.call(remote);
      } catch (error) {
        console.error('[VERA] Remote spawn failed:', slot, error);
      }
    }
    // A respawn must use the engine-selected spawn, not cached coordinates
    // from before death or from a previous occupant of this slot.
    const buffer = this.remoteBuffers.get(slot);
    if (buffer) buffer.length = 0;
    this.remoteLastStates.delete(slot);
    remote.__veraNetworkState = null;
    remote.__veraHasNetworkPosition = false;
    remote.__veraLastAlive = true;
    this.diagnostic('remote-spawn-awaiting-state', { slot, position: [remote.x, remote.y, remote.z], lastSequence: this.remoteLastSequences.get(slot) });
    return remote;
  }

  placeRemoteAtFallback(remote) {
    const game = this.game;
    const teamValue = remote && remote.__veraTeam === 'CT' ? 'CT' : 'T';
    const spawns = game && game.map && (teamValue === 'CT' ? game.map.spawnsCT : game.map.spawnsT);
    const spawn = spawns && spawns[0];
    if (!spawn) return;
    remote.x = finite(spawn.x); remote.y = finite(spawn.y) + 0.05; remote.z = finite(spawn.z);
    remote.yaw = finite(spawn.yaw);
    remote._visY = remote.y;
    remote.health = 100; remote.alive = true;
  }

  updateRemoteEntity(remote, delta) {
    const game = this.game;
    const dt = Math.max(0, Math.min(0.1, finite(delta, 0.033)));
    if (!game || !remote) return;
    const slot = Number(remote.__veraRemoteSlot);
    const sampled = this.sampleRemote(performance.now(), slot);
    if (sampled) this.applyRemoteState(sampled, false);

    if (!remote.alive) {
      remote.deathAnimT = Math.max(0, finite(remote.deathAnimT) - dt);
      if (remote.cs2Agent && remote.cs2Agent.root) remote.cs2Agent.root.visible = remote.deathAnimT > 0;
      if (game.respawnAllowed && game.roundActive) {
        remote.respawnT = finite(remote.respawnT) - dt;
        if (remote.respawnT <= 0) this.spawnRemoteEntity(remote);
      }
      return;
    }

    const original = this.remoteOriginals.get(slot);
    if (remote.cs2Agent && original && original.body) {
      try { original.body.call(remote, dt, game); } catch (error) {}
    }
    if (remote.cs2Agent && remote.cs2Agent.root) remote.cs2Agent.root.visible = true;
    if (remote.__veraFiringT > 0) {
      remote.__veraFiringT -= dt;
      if (remote.__veraFiringT <= 0 && remote.cs2Agent && remote.cs2Agent.play) {
        try { remote.cs2Agent.play('idle', { fade: 0.08 }); } catch (error) {}
      }
    }
  }

  startFrameLoop() {
    if (this.frameHandle) return;
    const frame = now => {
      this.frameHandle = requestAnimationFrame(frame);
      if (!this.active) return;
      if (now - this.lastRemoteClaimAt >= 500) {
        this.lastRemoteClaimAt = now;
        this.ensureHooks();
        this.claimRemoteSlots();
      }
      if (!this.remotes.size) return;
      for (const slot of this.remotes.keys()) {
        const state = this.sampleRemote(now, slot);
        if (state) this.applyRemoteState(state, false);
      }
      this.lastFrameAt = now;
    };
    this.frameHandle = requestAnimationFrame(frame);
  }

  stopFrameLoop() {
    if (this.frameHandle) cancelAnimationFrame(this.frameHandle);
    this.frameHandle = 0;
  }

  readLocalState() {
    const game = this.game;
    const player = game && game.player;
    if (!game || !player) return null;
    const weapon = game.weapons && game.weapons.current || 'knife';
    let ammo = 0;
    try { ammo = game.weapons.state(weapon).ammo; } catch (error) {}
    return {
      slot: this.slot,
      sequence: this.localSequence,
      tick: this.tick,
      x: player.x, y: player.y, z: player.z,
      vx: player.vx, vy: player.vy, vz: player.vz,
      yaw: player.yaw, pitch: player.pitch,
      weapon, ammo, health: player.health, armor: player.armor,
      alive: player.alive,
      crouching: player.crouching,
      onGround: player.onGround,
      walking: player.walking,
      reloading: !!(game.weapons && game.weapons.reloading),
      scoped: !!(game.weapons && game.weapons.scopeLevel),
      firing: !!(game.weapons && game.time - game.weapons.lastShotT < 0.12)
    };
  }

  encodeLocalState() {
    this.tick = (this.tick + 1) >>> 0;
    const state = this.readLocalState();
    if (state) state.sequence = (this.stateSequence = ((this.stateSequence || 0) + 1) >>> 0);
    return state ? encodeState(state) : null;
  }

  encodeRemoteState() {
    const remote = this.remote;
    if (!remote) return null;
    return encodeState({
      slot: Number(remote.__veraRemoteSlot) || (this.slot === 0 ? 1 : 0),
      sequence: this.stateSequence || 0,
      tick: this.tick,
      x: remote.x, y: remote.y, z: remote.z,
      vx: remote.vx, vy: remote.vy, vz: remote.vz,
      yaw: remote.yaw, pitch: remote._lookPitch || 0,
      weapon: remote.weapon, ammo: remote.ammo,
      health: remote.health, armor: remote.armor, alive: remote.alive,
      crouching: !!remote.crouchT, onGround: remote.onGround,
      walking: remote.walking, firing: remote.__veraFiringT > 0
    });
  }

  encodeRemoteStates() {
    const states = [];
    for (const remote of this.remotes.values()) {
      const state = this.encodeRemoteStateFor(remote);
      if (state) states.push(state);
    }
    return states;
  }

  encodeRemoteStateFor(remote) {
    if (!remote) return null;
    const sourceState = remote.__veraNetworkState;
    // Never relay an unpositioned placeholder. The host assigns a fresh,
    // monotonic sequence to each relayed remote-player stream.
    if (!sourceState) return null;
    const slot = Number(remote.__veraRemoteSlot) || 0;
    const sequence = ((this.remoteRelaySequences.get(slot) || 0) + 1) >>> 0;
    this.remoteRelaySequences.set(slot, sequence);
    return encodeState({
      slot,
      sequence,
      tick: this.tick,
      x: remote.x, y: remote.y, z: remote.z,
      vx: remote.vx, vy: remote.vy, vz: remote.vz,
      yaw: remote.yaw, pitch: remote._lookPitch || 0,
      weapon: remote.weapon, ammo: remote.ammo,
      health: remote.health, armor: remote.armor, alive: remote.alive,
      crouching: !!remote.crouchT, onGround: remote.onGround,
      walking: remote.walking, firing: remote.__veraFiringT > 0
    });
  }

  receiveState(packet, fromSlot = null) {
    const state = decodeState(packet);
    this.diagnostic(state ? 'packet-processing-decoded' : 'packet-processing-decode-failed', { active: this.active, role: this.role, localSlot: this.slot, packetBytes: packet && packet.byteLength, decodedSlot: state && state.slot, sequence: state && state.sequence });
    if (!state || !this.active) {
      this.diagnostic('state-invalid-or-inactive', { decoded: !!state, active: this.active, role: this.role, localSlot: this.slot, packetBytes: packet && packet.byteLength });
      return;
    }
    const senderSlot = Number(fromSlot);
    if (Number.isInteger(senderSlot) && senderSlot === this.slot) {
      this.diagnostic('state-self-echo', { senderSlot, localSlot: this.slot });
      return;
    }
    const payloadSlot = state.slot;
    // On the host, the signaling server's sender slot is authoritative.
    // This prevents stale client-side slot values after reconnects from
    // routing a guest's state into the wrong remote entity.
    if (this.role === 'host' && Number.isInteger(senderSlot) && senderSlot > 0 && senderSlot <= 31) {
      state.slot = senderSlot;
    }
    if (state.slot === this.slot) {
      this.diagnostic('state-mapped-to-local', { senderSlot, payloadSlot, role: this.role, localSlot: this.slot, sequence: state.sequence });
      if (this.role === 'guest') {
        if (!isNewerSequence(state.sequence, this.authoritativeLocalSequence)) {
          this.diagnostic('authoritative-local-stale', { sequence: state.sequence, lastSequence: this.authoritativeLocalSequence });
          return;
        }
        this.authoritativeLocalSequence = state.sequence;
        this.applyAuthoritativeLocal(state);
      }
      return;
    }
    if (!this.remotePlayers.has(state.slot)) this.remotePlayers.set(state.slot, '');
    this.claimRemoteSlots();
    const lastSequence = this.remoteLastSequences.get(state.slot);
    if (!isNewerSequence(state.sequence, lastSequence)) {
      this.diagnostic('state-stale', { senderSlot, payloadSlot, mappedSlot: state.slot, sequence: state.sequence, lastSequence });
      return;
    }
    this.diagnostic('state-accepted', { role: this.role, senderSlot, payloadSlot, mappedSlot: state.slot, sequence: state.sequence, position: [state.x, state.y, state.z], remoteExists: this.remotes.has(state.slot), rosterSlots: [...this.remotePlayers.keys()] });
    this.remoteLastSequences.set(state.slot, state.sequence);
    const now = performance.now();
    const buffer = this.remoteBuffers.get(state.slot) || [];
    buffer.push({ at: now, state });
    while (buffer.length > 12) buffer.shift();
    this.remoteBuffers.set(state.slot, buffer);
    this.diagnostic('packet-buffered-for-remote', { slot: state.slot, sequence: state.sequence, buffered: buffer.length, remoteMapped: this.remotes.has(state.slot) });
    this.remoteLastStates.set(state.slot, state);
    this.remoteLastState = state;
  }

  sampleRemote(now, slot = 1) {
    const buffer = this.remoteBuffers.get(Number(slot)) || this.remoteBuffer;
    if (!buffer.length) return null;
    const target = now - REMOTE_RENDER_DELAY;
    const first = buffer[0];
    const last = buffer[buffer.length - 1];
    if (target <= first.at) return first.state;
    for (let i = 1; i < buffer.length; i++) {
      const next = buffer[i];
      const prev = buffer[i - 1];
      if (target <= next.at) {
        const amount = Math.min(1, Math.max(0, (target - prev.at) / Math.max(1, next.at - prev.at)));
        return this.interpolateState(prev.state, next.state, amount);
      }
    }
    const extrapolation = Math.min(MAX_EXTRAPOLATION, Math.max(0, target - last.at)) / 1000;
    return { ...last.state, x: last.state.x + last.state.vx * extrapolation, y: last.state.y + last.state.vy * extrapolation, z: last.state.z + last.state.vz * extrapolation };
  }

  interpolateState(a, b, amount) {
    const lerp = (x, y) => x + (y - x) * amount;
    return {
      ...b,
      x: lerp(a.x, b.x), y: lerp(a.y, b.y), z: lerp(a.z, b.z),
      vx: lerp(a.vx, b.vx), vy: lerp(a.vy, b.vy), vz: lerp(a.vz, b.vz),
      yaw: angleLerp(a.yaw, b.yaw, amount), pitch: lerp(a.pitch, b.pitch)
    };
  }

  applyRemoteState(state, immediate = false) {
    const remote = state ? this.remotes.get(Number(state.slot)) : null;
    if (!remote || !state) {
      this.diagnostic('apply-no-remote', { stateSlot: state && state.slot, remoteSlots: [...this.remotes.keys()], rosterSlots: [...this.remotePlayers.keys()] });
      return;
    }
    const previous = { x: remote.x, y: remote.y, z: remote.z };
    const distance = distance3(previous, state);
    if (!immediate && remote.__veraHasNetworkPosition && distance > 12) {
      const pending = remote.__veraPendingNetworkJump;
      const confirmsJump = pending
        && isNewerSequence(state.sequence, pending.sequence)
        && distance3(pending, state) <= 3;
      if (!confirmsJump) {
        if (!pending || isNewerSequence(state.sequence, pending.sequence)) {
          remote.__veraPendingNetworkJump = {
            x: state.x, y: state.y, z: state.z, sequence: state.sequence
          };
        }
        this.diagnostic('apply-distance-rejected', { slot: state.slot, distance, previous, incoming: [state.x, state.y, state.z], pendingJump: true });
        return;
      }
      this.diagnostic('apply-distance-jump-confirmed', { slot: state.slot, distance, previous, incoming: [state.x, state.y, state.z], confirmingSequence: state.sequence });
    }
    remote.__veraPendingNetworkJump = null;
    remote.__veraHasNetworkPosition = true;
    remote.x = state.x; remote.y = state.y; remote.z = state.z;
    remote._visY = state.y;
    remote.vx = state.vx; remote.vy = state.vy; remote.vz = state.vz;
    remote.yaw = state.yaw; remote._lookPitch = state.pitch;
    remote.onGround = state.onGround;
    remote.walking = state.walking;
    remote.crouchT = state.crouching ? 0.2 : 0;
    remote.weapon = state.weapon;
    remote.ammo = state.ammo;
    remote.__veraNetworkState = state;
    this.diagnostic('player-to-bot-position-applied', { slot: state.slot, botName: remote.name, position: [state.x, state.y, state.z], previous, distance, weapon: state.weapon, incomingAlive: state.alive, incomingHealth: state.health, aliveBefore: remote.alive, deathAnimT: remote.deathAnimT, rootVisible: remote.cs2Agent && remote.cs2Agent.root && remote.cs2Agent.root.visible });

    // The host owns remote health/alive state. Guests receive it from the host.
    if (this.role !== 'host') {
      const wasAlive = remote.alive;
      remote.health = state.health;
      remote.alive = state.alive;
      this.diagnostic('remote-life-state-applied', { slot: state.slot, incomingAlive: state.alive, incomingHealth: state.health, aliveBefore: wasAlive, aliveAfter: remote.alive, deathAnimT: remote.deathAnimT, rootVisible: remote.cs2Agent && remote.cs2Agent.root && remote.cs2Agent.root.visible });
      if (wasAlive && !state.alive && remote.cs2Agent && remote.cs2Agent.die) {
        try { remote.cs2Agent.die('chest', false); } catch (error) {}
      }
    }
  }

  applyAuthoritativeLocal(state) {
    const game = this.game;
    const player = game && game.player;
    if (!player || !state) return;
    if (!state.alive && player.alive && typeof game.killEntity === 'function') {
      try { game.killEntity(player, null, null, true); } catch (error) { player.alive = false; }
    } else if (state.alive && !player.alive && typeof game.respawnPlayer === 'function') {
      try { game.respawnPlayer(); } catch (error) {}
    }
    // The guest owns local movement and view direction. The host echo is
    // authoritative for health/life state, not for the guest's coordinates.
    player.health = state.health;
    player.armor = state.armor;
    player.alive = state.alive;
  }

  weaponDefinition(id) {
    const game = this.game;
    if (!game || !game.weapons || typeof game.weapons.def !== 'function') return null;
    const previous = game.weapons.current;
    try {
      game.weapons.current = id;
      return game.weapons.def();
    } catch (error) {
      return null;
    } finally {
      game.weapons.current = previous;
    }
  }

  simulateRemoteMelee(event) {
    const game = this.game;
    const remoteSlot = Number(event && (event.slot ?? event.fromSlot));
    const remote = this.remotes.get(remoteSlot);
    const weapon = this.weaponDefinition('knife');
    const length = Math.hypot(finite(event && event.dirX), finite(event && event.dirY), finite(event && event.dirZ));
    if (!game || !remote || !weapon || weapon.class !== 'knife' || !Number.isFinite(length) || length < 0.5 || length > 1.5) {
      this.diagnostic('melee-rejected', { remoteSlot, game: !!game, remoteFound: !!remote, weaponFound: !!weapon, weaponClass: weapon && weapon.class });
      return;
    }
    const direction = [finite(event.dirX) / length, finite(event.dirY) / length, finite(event.dirZ) / length];
    // Use the attack-time origin: remote avatars are rendered with interpolation delay,
    // but the engine evaluates melee range and line of sight immediately.
    if ([event.x, event.y, event.z].every(value => Number.isFinite(Number(value)))) {
      remote.x = Number(event.x);
      remote.y = Number(event.y);
      remote.z = Number(event.z);
      remote._visY = remote.y;
    }
    remote.__veraFiringT = 0.18;
    this.diagnostic('melee-simulate', { remoteSlot, damage: event.damage, heavy: !!event.heavy, attacker: [remote.x, remote.y, remote.z], target: game.player && [game.player.x, game.player.y, game.player.z], localHealth: game.player && game.player.health });
    this.suppressNetwork = true;
    try {
      game.meleeAttack(remote, finite(event.damage, 40), weapon, finite(event.backDamage, 90), !!event.heavy, ...direction);
      this.diagnostic('melee-simulate-returned', { remoteSlot, localHealthAfter: game.player && game.player.health });
    } catch (error) {
      this.diagnostic('melee-simulate-error', { remoteSlot, error: String(error && error.stack || error) });
    } finally {
      this.suppressNetwork = false;
    }
  }

  simulateRemoteShot(event) {
    const game = this.game;
    const remoteSlot = Number(event && (event.slot ?? event.fromSlot));
    const remote = this.remotes.get(remoteSlot);
    const weapon = this.weaponDefinition(event && event.weapon);
    if (!game || !remote || !weapon) {
      this.diagnostic('shot-rejected', { remoteSlot, game: !!game, remoteFound: !!remote, remoteSlots: [...this.remotes.keys()], weaponId: event && event.weapon, weaponFound: !!weapon });
      return;
    }
    this.diagnostic('shot-simulate', { remoteSlot, weapon: event.weapon, shooterPosition: [remote.x, remote.y, remote.z], localPlayerPosition: game.player && [game.player.x, game.player.y, game.player.z], localHealth: game.player && game.player.health });
    const ox = finite(event.ox), oy = finite(event.oy), oz = finite(event.oz);
    const dx = finite(event.dx), dy = finite(event.dy), dz = finite(event.dz);
    const length = Math.hypot(dx, dy, dz);
    if (!Number.isFinite(length) || length < 0.5 || length > 1.5) return;
    remote.__veraFiringT = 0.18;
    this.suppressNetwork = true;
    try {
      game.fireBullet(remote, ox, oy, oz, dx / length, dy / length, dz / length, weapon);
      this.diagnostic('shot-firebullet-returned', { remoteSlot, localHealthAfter: game.player && game.player.health });
    } catch (error) {
      this.diagnostic('shot-firebullet-error', { remoteSlot, error: String(error && error.stack || error) });
    }
    this.suppressNetwork = false;
    try { game.audio && game.audio.play && game.audio.play(weapon.sound, { pos: remote }); } catch (error) {}
  }

  removeRemote(slot = null) {
    const manager = this.game && this.game.botMgr;
    const targets = slot == null ? [...this.remotes.entries()] : [[Number(slot), this.remotes.get(Number(slot))]];
    for (const [remoteSlot, remote] of targets) {
      if (!remote) continue;
      try { remote.cs2Agent && remote.cs2Agent.root && this.game.scene.remove(remote.cs2Agent.root); } catch (error) {}
      try { remote.shadow && this.game.scene.remove(remote.shadow); } catch (error) {}
      if (manager && Array.isArray(manager.bots)) {
        const index = manager.bots.indexOf(remote);
        if (index >= 0) manager.bots.splice(index, 1);
      }
      this.remotes.delete(Number(remoteSlot));
      this.remoteOriginals.delete(Number(remoteSlot));
    }
    if (slot == null) {
      this.remote = null;
      this.remotes.clear();
      this.remotePlayers.clear();
      this.remoteBuffer.length = 0;
      this.remoteBuffers.clear();
      this.remoteLastSequences.clear();
      this.remoteRelaySequences.clear();
      this.remoteLastStates.clear();
      this.remoteLastState = null;
    } else {
      const remoteSlot = Number(slot);
      this.remotePlayers.delete(remoteSlot);
      this.remoteBuffers.delete(remoteSlot);
      this.remoteLastSequences.delete(remoteSlot);
      this.remoteRelaySequences.delete(remoteSlot);
      this.remoteLastStates.delete(remoteSlot);
      if (this.remote === targets[0][1]) this.remote = this.remotes.get(1) || this.remotes.values().next().value || null;
    }
  }

  deactivate() {
    this.active = false;
    this.removeRemote();
    const manager = this.game && this.game.botMgr;
    if (manager && manager.__veraNetworkSetup && this.originalSetup) {
      manager.setup = this.originalSetup;
      delete manager.__veraNetworkSetup;
    }
    if (this.game && this.game.__veraNetworkFireHook && this.originalFireBullet) {
      this.game.fireBullet = this.originalFireBullet;
      delete this.game.__veraNetworkFireHook;
    }
    if (this.game && this.game.__veraNetworkMeleeHook && this.originalPlayerMelee) {
      this.game.playerMelee = this.originalPlayerMelee;
      delete this.game.__veraNetworkMeleeHook;
    }
    this.stopFrameLoop();
    this.game = null;
    this.originalSetup = null;
    this.originalFireBullet = null;
    this.originalPlayerMelee = null;
    this.remoteOriginals.clear();
  }
}
