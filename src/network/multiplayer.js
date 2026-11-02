import { VeraPeerTransport } from './webrtc.js?v=vera20';
import { VeraGameAdapter } from './game-adapter.js?v=vera20';
import { VeraRoomTransport } from './signaling.js?v=vera20';

const STATUS_TEXT = Object.freeze({
  offline: 'OFFLINE',
  'creating-offer': 'CREATING OFFER',
  gathering: 'PREPARING',
  waiting: 'WAITING',
  connecting: 'CONNECTING',
  connected: 'CONNECTED',
  'match-ready': 'CONNECTED — MATCH READY',
  disconnected: 'DISCONNECTED',
  error: 'CONNECTION ERROR'
});

function text(value) { return String(value == null ? '' : value); }
function finite(value, fallback = 0) { return Number.isFinite(Number(value)) ? Number(value) : fallback; }
function team(value) {
  const normalized = text(value).toUpperCase();
  return normalized === 'T' || normalized === 'CT' ? normalized : '';
}
function makeRoomCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let value = '';
  try {
    const bytes = new Uint8Array(6);
    crypto.getRandomValues(bytes);
    for (const byte of bytes) value += alphabet[byte % alphabet.length];
  } catch (error) {
    for (let index = 0; index < 6; index++) value += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return value;
}

class VeraMultiplayerSession {
  constructor() {
    this.config = window.VERA_NETWORK_CONFIG || {};
    this.signalingEnabled = !!this.config.signalingUrl;
    this.transport = null;
    this.adapter = new VeraGameAdapter();
    this.role = '';
    this.slot = 0;
    this.view = 'home';
    this.roomCode = '';
    this.hostOffer = '';
    this.guestAnswer = '';
    this.localTeam = '';
    this.remoteTeam = '';
    this.players = new Map();
    this.playerTeams = new Map();
    this.statusValue = 'offline';
    this.statusDetail = '';
    this.transportConnected = false;
    this.matchConfig = null;
    this.matchAnnounced = false;
    this.matchStarted = false;
    this.lastStateAt = 0;
    this.lastMatchAt = 0;
    this.seenEvents = new Set();
    this.ui = {};
    window.setInterval(() => this.pump(), 50);
    this.installUIWatch();
    window.addEventListener('beforeunload', () => this.leave(true));
  }

  installUIWatch() {
    this.ensureUI();
    window.setInterval(() => this.ensureUI(), 500);
  }

  ensureUI() {
    const menu = document.querySelector('#menu');
    if (!menu) return;
    // Frontend LAN trigger removed by request. Backend session stays intact
    // and remains callable via window.__veraMultiplayer.openPanel()/hostLan()/joinLan().
    const staleTrigger = document.querySelector('#vera-mp-trigger');
    if (staleTrigger) staleTrigger.remove();
    if (!document.querySelector('#vera-mp-panel')) this.createPanel();
    if (!document.querySelector('#vera-mp-style')) this.createStyle();
    this.updateUI();
  }

  createStyle() {
    const style = document.createElement('style');
    style.id = 'vera-mp-style';
    style.textContent = `
      #vera-mp-trigger { margin-top: 10px; width: 100%; min-height: 38px; color: #e8eef2; border: 1px solid rgba(168,85,247,.44); background: rgba(10,13,16,.78); cursor: pointer; letter-spacing: 1.8px; font-weight: 800; transition: border-color .16s, background .16s, color .16s; }
      #vera-mp-trigger:hover { border-color: var(--accent, #a855f7); background: rgba(168,85,247,.14); color: #fff; }
      /* LAN / Join frontend removed: never show a stale trigger or join button (e.g. cached DOM). */
      #vera-mp-trigger, [data-mp-join] { display: none !important; }
      .vera-mp-choice-grid-single { grid-template-columns: 1fr; }
      #vera-mp-panel { position: fixed; inset: 0; z-index: 1000; display: none; align-items: center; justify-content: center; padding: 24px; background: rgba(3,5,8,.82); backdrop-filter: blur(3px); font-family: inherit; }
      #vera-mp-panel.open { display: flex; }
      .vera-mp-card { width: min(760px, 94vw); max-height: 92vh; overflow: auto; color: #e8eef2; border: 1px solid rgba(255,255,255,.16); border-radius: 4px; background: #101419; box-shadow: 0 22px 70px rgba(0,0,0,.72), 0 0 0 1px rgba(168,85,247,.08); }
      .vera-mp-topbar { display: flex; align-items: center; gap: 12px; min-height: 76px; padding: 14px 20px; border-bottom: 1px solid rgba(255,255,255,.1); background: linear-gradient(180deg, rgba(255,255,255,.045), rgba(255,255,255,.012)); }
      .vera-mp-mark { display: grid; place-items: center; width: 34px; height: 34px; flex: 0 0 34px; border: 1px solid rgba(192,132,252,.64); color: #e9d5ff; font-size: 17px; font-weight: 900; font-style: italic; transform: skew(-8deg); }
      .vera-mp-heading { min-width: 0; flex: 1; }
      .vera-mp-kicker { color: #aeb9c2; font-size: 10px; font-weight: 800; letter-spacing: 2.3px; }
      .vera-mp-card h2 { margin: 3px 0 0; color: #fff; font-size: 21px; line-height: 1.1; letter-spacing: 2.5px; }
      .vera-mp-topright { display: flex; align-items: center; gap: 14px; }
      .vera-mp-close { width: 28px; height: 28px; border: 1px solid rgba(255,255,255,.14); background: rgba(255,255,255,.04); color: #aeb9c2; font-size: 18px; line-height: 1; cursor: pointer; }
      .vera-mp-close:hover { border-color: rgba(255,255,255,.34); color: #fff; background: rgba(255,255,255,.1); }
      .vera-mp-status { padding: 6px 8px; border: 1px solid rgba(168,85,247,.42); background: rgba(168,85,247,.1); color: #e9d5ff; font-size: 9px; font-weight: 800; letter-spacing: 1.2px; white-space: nowrap; }
      .vera-mp-body { padding: 22px; }
      .vera-mp-error { min-height: 17px; margin: -4px 0 10px; color: #8f9ba5; font-size: 12px; line-height: 1.4; }
      .vera-mp-error.is-error { color: #f59ca5; }
      .vera-mp-actions { display: grid; gap: 14px; }
      .vera-mp-intro { max-width: 560px; margin: 0 0 18px; color: #aeb9c2; font-size: 13px; line-height: 1.55; }
      .vera-mp-choice-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
      .vera-mp-choice { min-height: 150px; padding: 18px; text-align: left; border: 1px solid rgba(255,255,255,.13); border-radius: 3px; background: rgba(5,7,9,.42); color: #e8eef2; cursor: pointer; transition: border-color .16s, background .16s, transform .16s; }
      .vera-mp-choice:hover { border-color: rgba(192,132,252,.72); background: rgba(168,85,247,.1); transform: translateY(-2px); }
      .vera-mp-choice-icon { display: grid; place-items: center; width: 30px; height: 30px; margin-bottom: 16px; border: 1px solid rgba(255,255,255,.25); color: #c084fc; font-size: 14px; font-weight: 900; }
      .vera-mp-choice h3 { margin: 0 0 7px; color: #fff; font-size: 14px; letter-spacing: 1.4px; }
      .vera-mp-choice p { margin: 0; color: #8f9ba5; font-size: 12px; line-height: 1.45; }
      .vera-mp-footnote { margin-top: 17px; color: #72808a; font-size: 11px; letter-spacing: .2px; }
      .vera-mp-flow { display: flex; align-items: center; gap: 8px; margin: 0 0 22px; padding-bottom: 14px; border-bottom: 1px solid rgba(255,255,255,.1); }
      .vera-mp-step { display: flex; align-items: center; gap: 7px; color: #67737d; font-size: 10px; font-weight: 800; letter-spacing: 1px; }
      .vera-mp-step b { display: grid; place-items: center; width: 21px; height: 21px; border: 1px solid rgba(255,255,255,.18); font-size: 10px; font-weight: 800; }
      .vera-mp-step.active { color: #e9d5ff; }
      .vera-mp-step.active b { border-color: #c084fc; background: rgba(168,85,247,.18); color: #fff; }
      .vera-mp-step-line { height: 1px; flex: 1; background: rgba(255,255,255,.12); }
      .vera-mp-room { display: none; }
      .vera-mp-room.show { display: block; }
      .vera-mp-room-title { margin-bottom: 5px; color: #fff; font-size: 16px; font-weight: 800; letter-spacing: 1.5px; }
      .vera-mp-room-id { display: flex; align-items: baseline; gap: 9px; margin: 0 0 10px; color: #8f9ba5; font: 800 10px/1.2 ui-monospace, monospace; letter-spacing: 1.2px; }
      .vera-mp-room-id strong { color: #e9d5ff; font-size: 15px; letter-spacing: 3px; }
      .vera-mp-room-id em { color: #67737d; font-size: 9px; font-style: normal; letter-spacing: .4px; }
      .vera-mp-help { max-width: 620px; color: #8f9ba5; font-size: 12px; line-height: 1.55; margin: 0 0 14px; }
      .vera-mp-auto { display: none; }
      .vera-mp-auto-note { max-width: 620px; margin: 0 0 14px; padding: 10px 12px; border-left: 2px solid #a855f7; background: rgba(168,85,247,.08); color: #cbd5df; font-size: 12px; line-height: 1.5; }
      .vera-mp-auto-note strong { color: #fff; }
      .vera-mp-auto button { width: 100%; min-height: 42px; border: 1px solid rgba(168,85,247,.65); border-radius: 2px; background: rgba(168,85,247,.18); color: #fff; font-weight: 900; letter-spacing: 1.2px; cursor: pointer; }
      .vera-mp-auto button:hover { background: rgba(168,85,247,.3); }
      .vera-mp-team { display: none; margin-top: 20px; padding-top: 18px; border-top: 1px solid rgba(255,255,255,.1); }
      .vera-mp-team.show { display: block; }
      .vera-mp-team-title { color: #fff; font-size: 14px; font-weight: 800; letter-spacing: 1.5px; }
      .vera-mp-team-help { margin: 6px 0 12px; color: #8f9ba5; font-size: 12px; line-height: 1.5; }
      .vera-mp-team-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 9px; }
      .vera-mp-team button { min-height: 44px; border: 1px solid rgba(255,255,255,.16); border-radius: 2px; background: rgba(255,255,255,.055); color: #e8eef2; font-size: 11px; font-weight: 900; letter-spacing: 1px; cursor: pointer; transition: border-color .16s, background .16s, color .16s, transform .16s; }
      .vera-mp-team button:hover { border-color: rgba(192,132,252,.72); background: rgba(168,85,247,.14); transform: translateY(-1px); }
      .vera-mp-team button.is-selected[data-mp-team="CT"] { border-color: #60a5fa; background: rgba(37,99,235,.2); color: #bfdbfe; }
      .vera-mp-team button.is-selected[data-mp-team="T"] { border-color: #f5b942; background: rgba(245,158,11,.17); color: #fde68a; }
      .vera-mp-label { display: flex; align-items: center; justify-content: space-between; margin: 16px 0 6px; color: #aeb9c2; font-size: 10px; font-weight: 800; letter-spacing: 1.7px; }
      .vera-mp-label em { color: #67737d; font-size: 9px; font-style: normal; letter-spacing: .8px; }
      .vera-mp-signal { width: 100%; min-height: 92px; resize: vertical; box-sizing: border-box; border: 1px solid rgba(255,255,255,.16); border-radius: 2px; padding: 10px; outline: none; background: #090c0f; color: #dfe7eb; font: 11px/1.35 ui-monospace, monospace; overflow-wrap: anywhere; }
      .vera-mp-signal:focus { border-color: rgba(192,132,252,.72); box-shadow: 0 0 0 2px rgba(168,85,247,.1); }
      .vera-mp-signal::selection { background: rgba(192,132,252,.55); }
      .vera-mp-code { width: 100%; box-sizing: border-box; min-height: 40px; border: 1px solid rgba(255,255,255,.16); border-radius: 2px; padding: 0 10px; outline: none; background: #090c0f; color: #e9d5ff; font: 800 13px/40px ui-monospace, monospace; letter-spacing: 2px; text-transform: uppercase; }
      .vera-mp-code:focus { border-color: rgba(192,132,252,.72); box-shadow: 0 0 0 2px rgba(168,85,247,.1); }
      .vera-mp-actions button, .vera-mp-room button { min-height: 40px; border: 1px solid rgba(255,255,255,.16); border-radius: 2px; background: rgba(255,255,255,.065); color: #e8eef2; font-weight: 800; letter-spacing: 1.2px; cursor: pointer; transition: background .16s, border-color .16s, color .16s; }
      .vera-mp-actions button:hover, .vera-mp-room button:hover { border-color: rgba(192,132,252,.7); background: rgba(168,85,247,.16); color: #fff; }
      .vera-mp-room [data-mp-accept-answer], .vera-mp-room [data-mp-create-answer] { width: 100%; margin-top: 10px; border-color: rgba(168,85,247,.65); background: rgba(168,85,247,.18); }
      .vera-mp-room [data-mp-accept-answer]:hover, .vera-mp-room [data-mp-create-answer]:hover { background: rgba(168,85,247,.3); }
      .vera-mp-row { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 8px; }
      #vera-mp-pill { position: fixed; right: 14px; top: 14px; z-index: 90; display: none; padding: 7px 10px; border: 1px solid rgba(168,85,247,.42); border-radius: 2px; background: rgba(10,13,16,.92); color: #e9d5ff; font: 800 10px/1.2 ui-monospace, monospace; letter-spacing: 1px; pointer-events: none; }
      #vera-mp-pill.show { display: block; }
      @media (max-width: 620px) { .vera-mp-card { width: 96vw; } .vera-mp-body { padding: 18px; } .vera-mp-choice-grid, .vera-mp-row { grid-template-columns: 1fr; } .vera-mp-topright { gap: 7px; } .vera-mp-status { max-width: 120px; overflow: hidden; text-overflow: ellipsis; } }
    `;
    document.head.appendChild(style);
  }

  createPanel() {
    const panel = document.createElement('div');
    panel.id = 'vera-mp-panel';
    panel.innerHTML = `
      <div class="vera-mp-card" role="dialog" aria-modal="true" aria-labelledby="vera-mp-title">
        <div class="vera-mp-topbar">
          <div class="vera-mp-mark" aria-hidden="true">V</div>
          <div class="vera-mp-heading"><div class="vera-mp-kicker">VERA // LOCAL PLAY</div><h2 id="vera-mp-title">LAN MULTIPLAYER</h2></div>
          <div class="vera-mp-topright"><div class="vera-mp-status" data-mp-status>OFFLINE</div><button class="vera-mp-close" type="button" aria-label="Close">×</button></div>
        </div>
        <div class="vera-mp-body">
          <div class="vera-mp-error" data-mp-error></div>
          <div class="vera-mp-actions" data-mp-actions>
            <p class="vera-mp-intro">Create a room on the Vera server, share its code, and let friends join from anywhere your server is reachable. Choose a team and fight in the same endless match.</p>
            <div class="vera-mp-choice-grid vera-mp-choice-grid-single">
              <button class="vera-mp-choice" type="button" data-mp-host><span class="vera-mp-choice-icon" aria-hidden="true">A</span><h3>CREATE ROOM</h3><p>Start a room and share its six-character code with your friends.</p></button>
              <!-- JOIN ROOM frontend removed by request; backend joinLan()/joinSignalingRoom() kept intact. -->
            </div>
            <div class="vera-mp-footnote">Up to 20 players per room · uneven teams allowed · endless T vs CT</div>
          </div>
          <div class="vera-mp-flow" data-mp-flow aria-label="Connection progress">
            <span class="vera-mp-step active" data-mp-step="1"><b>1</b> ROLE</span><i class="vera-mp-step-line"></i><span class="vera-mp-step" data-mp-step="2"><b>2</b> EXCHANGE</span><i class="vera-mp-step-line"></i><span class="vera-mp-step" data-mp-step="3"><b>3</b> READY</span>
          </div>
          <div class="vera-mp-room" data-mp-host-room>
            <div class="vera-mp-room-title">Host a private match</div>
            <div class="vera-mp-room-id">ROOM CODE <strong data-mp-room-code>------</strong><em>SESSION LABEL</em></div>
            <div class="vera-mp-auto" data-mp-host-auto>
              <div class="vera-mp-auto-note"><strong>Share this room code.</strong> Your Python Vera server keeps the room open and relays compact game packets. Friends only need this code.</div>
              <div class="vera-mp-row"><button type="button" data-mp-copy-room>COPY ROOM CODE</button><button type="button" data-mp-leave>END SESSION</button></div>
            </div>
            <div class="vera-mp-manual" data-mp-host-manual>
              <div class="vera-mp-help">Tell your friend this room code so they can identify the session. The direct connection invite below completes the fallback handshake when no Python signaling server is configured.</div>
              <label class="vera-mp-label" for="vera-mp-host-offer">YOUR INVITE <em>GENERATED FOR THIS SESSION</em></label>
              <textarea id="vera-mp-host-offer" class="vera-mp-signal" data-mp-host-offer readonly aria-label="Host connection invite"></textarea>
              <div class="vera-mp-row"><button type="button" data-mp-copy-offer>COPY INVITE</button><button type="button" data-mp-leave>END SESSION</button></div>
              <label class="vera-mp-label" for="vera-mp-host-answer">FRIEND'S ANSWER</label>
              <textarea id="vera-mp-host-answer" class="vera-mp-signal" data-mp-host-answer placeholder="Paste the answer here" aria-label="Friend's answer"></textarea>
              <button type="button" data-mp-accept-answer>START LAN MATCH</button>
            </div>
          </div>
          <div class="vera-mp-room" data-mp-guest-room>
            <div class="vera-mp-room-title">Join a private match</div>
            <div class="vera-mp-help">Enter the six-character room code from the host. Anyone with the code can join while the room has space.</div>
            <label class="vera-mp-label" for="vera-mp-guest-code">ROOM CODE <em>FROM THE HOST</em></label>
            <input id="vera-mp-guest-code" class="vera-mp-code" data-mp-guest-code maxlength="6" spellcheck="false" autocomplete="off" placeholder="------" aria-label="Room code">
            <div class="vera-mp-auto" data-mp-guest-auto>
              <div class="vera-mp-auto-note">The Python server will find the room automatically. No offer, answer, or ICE details are exposed.</div>
              <button type="button" data-mp-auto-join>JOIN ROOM</button>
            </div>
            <div class="vera-mp-manual" data-mp-guest-manual>
              <label class="vera-mp-label" for="vera-mp-guest-offer">HOST INVITE</label>
              <textarea id="vera-mp-guest-offer" class="vera-mp-signal" data-mp-guest-offer placeholder="Paste the invite here" aria-label="Host invite"></textarea>
              <button type="button" data-mp-create-answer>CREATE REPLY</button>
              <label class="vera-mp-label" for="vera-mp-guest-answer">YOUR REPLY <em>RETURN THIS TO THE HOST</em></label>
              <textarea id="vera-mp-guest-answer" class="vera-mp-signal" data-mp-guest-answer readonly aria-label="Your connection reply"></textarea>
              <div class="vera-mp-row"><button type="button" data-mp-copy-answer>COPY REPLY</button><button type="button" data-mp-leave>END SESSION</button></div>
            </div>
          </div>
          <div class="vera-mp-team" data-mp-team-panel>
            <div class="vera-mp-team-title">CHOOSE YOUR TEAM</div>
            <p class="vera-mp-team-help">Pick a side after the room connection is ready. Vera does not auto-balance teams, so any number of players can join either side.</p>
            <div class="vera-mp-team-grid">
              <button type="button" data-mp-team="CT">CT&nbsp;&nbsp; COUNTER-TERRORISTS</button>
              <button type="button" data-mp-team="T">T&nbsp;&nbsp; TERRORISTS</button>
            </div>
          </div>
        </div>
      </div>`;
    document.body.appendChild(panel);
    const pill = document.createElement('div');
    pill.id = 'vera-mp-pill';
    document.body.appendChild(pill);
    this.ui = {
      panel,
      status: panel.querySelector('[data-mp-status]'),
      error: panel.querySelector('[data-mp-error]'),
      actions: panel.querySelector('[data-mp-actions]'),
      hostRoom: panel.querySelector('[data-mp-host-room]'),
      guestRoom: panel.querySelector('[data-mp-guest-room]'),
      hostOffer: panel.querySelector('[data-mp-host-offer]'),
      hostAnswer: panel.querySelector('[data-mp-host-answer]'),
      guestOffer: panel.querySelector('[data-mp-guest-offer]'),
      guestAnswer: panel.querySelector('[data-mp-guest-answer]'),
      roomCode: panel.querySelector('[data-mp-room-code]'),
      guestCode: panel.querySelector('[data-mp-guest-code]'),
      hostAuto: panel.querySelector('[data-mp-host-auto]'),
      hostManual: panel.querySelector('[data-mp-host-manual]'),
      guestAuto: panel.querySelector('[data-mp-guest-auto]'),
      guestManual: panel.querySelector('[data-mp-guest-manual]'),
      teamPanel: panel.querySelector('[data-mp-team-panel]'),
      teamButtons: panel.querySelectorAll('[data-mp-team]'),
      steps: panel.querySelectorAll('[data-mp-step]'),
      pill
    };
    panel.querySelector('.vera-mp-close').addEventListener('click', () => this.closePanel());
    panel.querySelector('[data-mp-host]').addEventListener('click', () => this.hostLan());
    // Join frontend removed; backend joinLan()/joinSignalingRoom() intentionally kept.
    const joinChoice = panel.querySelector('[data-mp-join]');
    if (joinChoice) joinChoice.remove();
    panel.querySelector('[data-mp-copy-offer]').addEventListener('click', () => this.copyText(this.ui.hostOffer.value, 'Offer copied.'));
    panel.querySelector('[data-mp-copy-room]').addEventListener('click', () => this.copyText(this.roomCode, 'Room code copied.'));
    panel.querySelector('[data-mp-accept-answer]').addEventListener('click', () => this.acceptAnswer());
    panel.querySelector('[data-mp-create-answer]').addEventListener('click', () => this.createAnswer());
    panel.querySelector('[data-mp-auto-join]').addEventListener('click', () => this.joinSignalingRoom());
    panel.querySelector('[data-mp-copy-answer]').addEventListener('click', () => this.copyText(this.ui.guestAnswer.value, 'Answer copied.'));
    this.ui.teamButtons.forEach(button => button.addEventListener('click', () => this.selectTeam(button.dataset.mpTeam)));
    panel.querySelectorAll('[data-mp-leave]').forEach(button => button.addEventListener('click', () => this.leave(false)));
  }

  updateUI() {
    if (!this.ui.panel) return;
    this.ui.status.textContent = STATUS_TEXT[this.statusValue] || text(this.statusValue).toUpperCase();
    this.ui.error.textContent = this.statusDetail || '';
    this.ui.error.classList.toggle('is-error', this.statusValue === 'error');
    this.ui.actions.style.display = this.view === 'home' ? '' : 'none';
    this.ui.hostRoom.classList.toggle('show', this.view === 'host');
    this.ui.guestRoom.classList.toggle('show', this.view === 'guest');
    const showAuto = this.signalingEnabled;
    if (this.ui.hostAuto) this.ui.hostAuto.style.display = showAuto ? 'block' : 'none';
    if (this.ui.hostManual) this.ui.hostManual.style.display = showAuto ? 'none' : 'block';
    if (this.ui.guestAuto) this.ui.guestAuto.style.display = showAuto ? 'block' : 'none';
    if (this.ui.guestManual) this.ui.guestManual.style.display = showAuto ? 'none' : 'block';
    if (this.ui.teamPanel) {
      const canChoose = !!this.role && this.transportConnected && !this.matchStarted;
      this.ui.teamPanel.classList.toggle('show', canChoose);
      this.ui.teamButtons.forEach(button => button.classList.toggle('is-selected', team(button.dataset.mpTeam) === this.localTeam));
    }
    if (this.hostOffer && this.ui.hostOffer.value !== this.hostOffer) this.ui.hostOffer.value = this.hostOffer;
    if (this.guestAnswer && this.ui.guestAnswer.value !== this.guestAnswer) this.ui.guestAnswer.value = this.guestAnswer;
    if (this.ui.roomCode) this.ui.roomCode.textContent = this.roomCode || '------';
    const activeStep = this.view === 'home' ? 1 : (this.matchStarted || (this.statusValue === 'connected' && this.localTeam && this.remoteTeam) ? 3 : 2);
    this.ui.steps.forEach(step => step.classList.toggle('active', Number(step.dataset.mpStep) <= activeStep));
    if (this.ui.pill) {
      const visible = this.statusValue !== 'offline' && this.statusValue !== 'error';
      this.ui.pill.textContent = `VERA · ${STATUS_TEXT[this.statusValue] || this.statusValue.toUpperCase()}`;
      this.ui.pill.classList.toggle('show', visible);
    }
  }

  setStatus(value, detail = '') {
    this.statusValue = value;
    this.statusDetail = detail;
    this.updateUI();
  }

  openPanel() {
    this.ensureUI();
    if (this.ui.panel) this.ui.panel.classList.add('open');
  }

  closePanel() {
    if (this.ui.panel) this.ui.panel.classList.remove('open');
  }

  newTransport(role) {
    if (this.transport) this.transport.close();
    this.role = role;
    this.slot = role === 'host' ? 0 : 1;
    this.transportConnected = false;
    this.matchAnnounced = false;
    this.matchStarted = false;
    this.localTeam = '';
    this.remoteTeam = '';
    this.players.clear();
    this.playerTeams.clear();
    this.seenEvents.clear();
    this.adapter.activate(role, this.slot);
    this.adapter.remoteTeam = '';
    const transport = this.transport = this.signalingEnabled
      ? new VeraRoomTransport(this.config.signalingUrl)
      : new VeraPeerTransport(this.config);
    transport.onStatus = (status, detail) => {
      if (status === 'connected' && !this.signalingEnabled) this.transportConnected = true;
      if (status === 'disconnected') this.transportConnected = false;
      this.setStatus(status, detail);
    };
    if (this.signalingEnabled) {
      transport.onRoom = room => this.handleRoomAssigned(room);
    }
    transport.onPeer = peer => {
      if (peer.connected) {
        if (peer.slot != null) this.players.set(Number(peer.slot), { slot: Number(peer.slot), role: peer.role || 'guest' });
        if (Array.isArray(peer.players)) this.setPlayerRoster(peer.players);
        this.transportConnected = true;
        this.setStatus(this.role === 'host' && !this.matchStarted && !peer.joined ? 'waiting' : 'connected',
          this.role === 'host' && !peer.joined ? 'Room created. Share the code and wait for players.' : 'Room connected. Choose T or CT.');
        this.updateUI();
      } else if (peer.connected === false) {
        if (peer.left && peer.slot != null) {
          this.players.delete(Number(peer.slot));
          this.playerTeams.delete(Number(peer.slot));
          this.adapter.remotePlayers.delete(Number(peer.slot));
          this.adapter.removeRemote(Number(peer.slot));
          this.updateUI();
          return;
        }
        this.transportConnected = false;
        this.matchStarted = false;
        this.adapter.removeRemote();
        this.setStatus('disconnected', peer.closed ? 'The room host closed the room.' : 'The room connection was lost.');
      }
    };
    transport.onState = packet => this.adapter.receiveState(packet);
    transport.onControl = (message, fromSlot) => this.handleControl(message, fromSlot);
    transport.onError = error => this.setStatus('error', error.message);
    this.adapter.onLocalShot = event => {
      if (!this.transport || !this.markEvent(event.eventId)) return;
      this.transport.sendControl({ ...event, from: this.role, slot: this.slot });
    };
  }

  handleRoomAssigned(message) {
    this.roomCode = text(message.code).toUpperCase();
    if (Number.isInteger(Number(message.slot))) {
      this.slot = Math.max(0, Math.min(31, Number(message.slot)));
      this.adapter.slot = this.slot;
    }
    if (Array.isArray(message.players)) this.setPlayerRoster(message.players);
    this.players.set(this.slot, { slot: this.slot, role: this.role });
    this.setStatus(this.role === 'host' ? 'waiting' : 'connected', this.role === 'host'
      ? 'Room created. Share the code and wait for players.'
      : 'Room found. Choose T or CT.');
    this.updateUI();
  }

  setPlayerRoster(players = []) {
    for (const entry of players) {
      const slot = Number(entry && entry.slot);
      if (!Number.isInteger(slot) || slot < 0 || slot > 31) continue;
      this.players.set(slot, { slot, role: entry.role === 'host' ? 'host' : 'guest' });
      if (team(entry.team)) this.playerTeams.set(slot, team(entry.team));
    }
    this.adapter.setRemotePlayers([...this.players.values()].map(player => ({
      slot: player.slot,
      team: this.playerTeams.get(player.slot) || ''
    })));
  }

  selectTeam(value) {
    const chosen = team(value);
    if (!chosen || !this.transportConnected || !this.transport || this.matchStarted) return;
    this.localTeam = chosen;
    this.playerTeams.set(this.slot, chosen);
    this.players.set(this.slot, { slot: this.slot, role: this.role, team: chosen });
    this.adapter.setRemotePlayers([...this.players.values()].map(player => ({
      slot: player.slot,
      team: this.playerTeams.get(player.slot) || ''
    })));
    this.transport.sendControl({ type: 'team-select', team: chosen, slot: this.slot });
    this.setStatus('waiting', this.role === 'host'
      ? 'Team selected. Waiting for another player to choose a side.'
      : 'Team selected. Waiting for the host to start the match.');
    if (this.role === 'host') this.beginHostMatch();
  }

  async hostLan() {
    this.openPanel();
    this.view = 'host';
    this.roomCode = makeRoomCode();
    this.setStatus('creating-offer');
    try {
      this.newTransport('host');
      if (this.signalingEnabled) {
        await this.transport.join('host');
        this.transportConnected = true;
        this.setStatus('waiting', 'Room created. Share the code and wait for players.');
      } else {
        this.hostOffer = await this.transport.createHostOffer();
        this.setStatus('waiting', 'Send the invite and room code to the joining device.');
      }
      this.updateUI();
    } catch (error) {
      this.setStatus('error', error.message);
    }
  }

  joinLan() {
    this.openPanel();
    this.view = 'guest';
    this.roomCode = '';
    this.newTransport('guest');
    this.setStatus('waiting', this.signalingEnabled ? 'Enter the room code to connect automatically.' : 'Enter the room code, then paste the host invite.');
  }

  async joinSignalingRoom() {
    const code = text(this.ui.guestCode && this.ui.guestCode.value).replace(/[^A-Za-z0-9]/g, '').toUpperCase();
    if (code.length !== 6) { this.setStatus('error', 'Enter the six-character room code shown by the host.'); return; }
    this.roomCode = code;
    try {
      this.setStatus('connecting', 'Finding the room on the Python server.');
      if (!this.transport || !this.signalingEnabled) throw new Error('The room server is not configured for this build.');
      await this.transport.join('guest', code);
      this.transportConnected = true;
      this.setStatus('connected', 'Room found. Choose T or CT.');
    } catch (error) {
      this.setStatus('error', error.message);
    }
  }

  async createAnswer() {
    const offer = this.ui.guestOffer && this.ui.guestOffer.value;
    if (!offer) { this.setStatus('error', 'Paste the host offer first.'); return; }
    const code = text(this.ui.guestCode && this.ui.guestCode.value).replace(/[^A-Za-z0-9]/g, '').toUpperCase();
    if (code.length !== 6) { this.setStatus('error', 'Enter the six-character room code shown by the host.'); return; }
    this.roomCode = code;
    try {
      this.setStatus('gathering');
      this.guestAnswer = await this.transport.acceptGuestOffer(offer);
      this.setStatus('waiting', 'Send your reply back to the host device.');
      this.updateUI();
    } catch (error) {
      this.setStatus('error', error.message);
    }
  }

  async acceptAnswer() {
    const answer = this.ui.hostAnswer && this.ui.hostAnswer.value;
    if (!answer) { this.setStatus('error', 'Paste the joiner answer first.'); return; }
    try {
      await this.transport.acceptHostAnswer(answer);
      this.setStatus('connecting', 'Waiting for the direct browser link.');
    } catch (error) {
      this.setStatus('error', error.message);
    }
  }

  async beginHostMatch() {
    if (!this.transportConnected || !this.localTeam || this.role !== 'host') return;
    const hasGuest = [...this.players.keys()].some(slot => slot !== this.slot && this.playerTeams.has(slot));
    if (!hasGuest) return;
    const selected = this.adapter.selectedMatch();
    this.matchConfig = { map: selected.map, mode: 'dm' };
    const players = [...this.players.values()]
      .filter(player => this.playerTeams.has(player.slot))
      .map(player => ({ slot: player.slot, role: player.role, team: this.playerTeams.get(player.slot) }));
    this.adapter.setRemotePlayers(players);
    const message = {
      type: 'match-start',
      map: this.matchConfig.map,
      mode: this.matchConfig.mode,
      hostTeam: this.localTeam,
      players
    };
    if (!this.transport.sendControl(message)) return;
    this.matchAnnounced = true;
    if (!this.matchStarted) await this.beginMatch(this.matchConfig, this.localTeam, players);
  }

  async beginMatch(config, team, players = []) {
    if (this.matchStarted) return;
    this.matchStarted = true;
    if (players.length) this.setPlayerRoster(players);
    this.setStatus('connecting');
    try {
      await this.adapter.startMatch({ map: config.map, mode: 'dm', team });
      this.transport.sendControl({ type: 'match-ready', from: this.role });
      this.setStatus('match-ready');
      this.closePanel();
    } catch (error) {
      this.matchStarted = false;
      this.setStatus('error', error.message);
    }
  }

  handleControl(message, fromSlot = 1) {
    if (!message || typeof message.type !== 'string') return;
    if (message.type === 'team-select') {
      const chosen = team(message.team);
      const slot = Number.isInteger(Number(message.slot)) ? Number(message.slot) : Number(fromSlot);
      if (!chosen || !Number.isInteger(slot) || slot < 0 || slot > 31) return;
      this.playerTeams.set(slot, chosen);
      const existing = this.players.get(slot) || { slot, role: slot === 0 ? 'host' : 'guest' };
      this.players.set(slot, { ...existing, team: chosen });
      this.adapter.setRemotePlayers([...this.players.values()].map(player => ({ slot: player.slot, team: this.playerTeams.get(player.slot) || '' })));
      this.updateUI();
      if (this.role === 'host') this.beginHostMatch();
      return;
    }
    if (message.type === 'match-start' && this.role === 'guest') {
      const players = Array.isArray(message.players) ? message.players : [];
      this.setPlayerRoster(players);
      const localEntry = players.find(player => Number(player && player.slot) === this.slot);
      this.localTeam = team(localEntry && localEntry.team) || team(message.guestTeam) || this.localTeam || 'T';
      this.remoteTeam = team(message.hostTeam) || '';
      this.matchConfig = { map: text(message.map) || 'oasis', mode: 'dm' };
      this.beginMatch(this.matchConfig, this.localTeam, players);
      return;
    }
    if (message.type === 'match-ready') {
      this.setStatus('match-ready');
      return;
    }
    if (message.type === 'match-state' && this.role === 'guest') {
      const game = this.adapter.game;
      if (game && game.state === 'playing') {
        if (Number.isFinite(message.roundTimeLeft)) game.roundTimeLeft = Math.max(0, message.roundTimeLeft);
        if (typeof message.roundActive === 'boolean') game.roundActive = message.roundActive;
        if (game.hud && game.hud.update) { try { game.hud.update(0); } catch (error) {} }
      }
      return;
    }
    if (message.type === 'fire') {
      if (!this.markEvent(message.eventId)) return;
      this.adapter.simulateRemoteShot(message);
    }
  }

  markEvent(id) {
    const key = text(id);
    if (!key || this.seenEvents.has(key)) return false;
    this.seenEvents.add(key);
    while (this.seenEvents.size > 256) this.seenEvents.delete(this.seenEvents.values().next().value);
    return true;
  }

  pump() {
    try {
      if (this.role === 'host' && this.transportConnected && !this.matchAnnounced) this.beginHostMatch();
      if (!this.transport || !this.transportConnected || !this.matchStarted) return;
      const now = performance.now();
      if (now - this.lastStateAt >= 45) {
        const local = this.adapter.encodeLocalState();
        if (local) this.transport.sendState(local);
        if (this.role === 'host') {
          for (const remote of this.adapter.encodeRemoteStates()) this.transport.sendState(remote);
        }
        this.lastStateAt = now;
      }
      if (this.role === 'host' && now - this.lastMatchAt >= 200) {
        const game = this.adapter.game;
        if (game) this.transport.sendControl({ type: 'match-state', roundActive: !!game.roundActive, roundTimeLeft: finite(game.roundTimeLeft), mode: game.mode, phase: game.state });
        this.lastMatchAt = now;
      }
    } catch (error) {}
  }

  async copyText(value, successMessage) {
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      this.setStatus(this.statusValue, successMessage);
    } catch (error) {
      this.setStatus(this.statusValue, 'Copy unavailable — select the connection text manually.');
    }
  }

  leave(silent) {
    if (this.transport) this.transport.close();
    this.transport = null;
    this.adapter.deactivate();
    this.role = '';
    this.slot = 0;
    this.view = 'home';
    this.hostOffer = '';
    this.guestAnswer = '';
    this.roomCode = '';
    this.localTeam = '';
    this.remoteTeam = '';
    this.players.clear();
    this.playerTeams.clear();
    this.adapter.remoteTeamOverride = '';
    this.transportConnected = false;
    this.matchStarted = false;
    this.matchAnnounced = false;
    this.seenEvents.clear();
    this.setStatus('offline');
    if (!silent && this.ui.panel) this.ui.panel.classList.add('open');
  }

  status() {
    return { status: this.statusValue, role: this.role, connected: this.transportConnected, matchStarted: this.matchStarted, players: this.players.size, remote: !!this.adapter.remote };
  }
}

const session = new VeraMultiplayerSession();
window.__veraMultiplayer = session;
