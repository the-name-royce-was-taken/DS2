/*
 * Browser client for Vera's small Python signaling service.
 *
 * The small Python service handles room membership and compact relay packets.
 * The relay path is intentional: it supports rooms larger than a two-peer
 * WebRTC mesh while keeping the browser frontend static and GitHub Pages-safe.
 */

function noop() {}

function signalingUrl(value) {
  let valueText = String(value || '').trim();
  if (!valueText) return '';
  if (/^https?:\/\//i.test(valueText)) valueText = valueText.replace(/^http/i, 'ws');
  if (!/^wss?:\/\//i.test(valueText)) valueText = `wss://${valueText}`;
  return valueText.endsWith('/signal') ? valueText : `${valueText.replace(/\/$/, '')}/signal`;
}

function bytesToBase64(value) {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value || 0);
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(bytes.length, offset + chunkSize)));
  }
  return btoa(binary);
}

function base64ToArrayBuffer(value) {
  if (typeof value !== 'string' || value.length > 1024) return null;
  try {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
    return bytes.buffer;
  } catch (error) {
    return null;
  }
}

export class VeraSignalingClient {
  constructor(url) {
    this.url = signalingUrl(url);
    this.socket = null;
    this.closed = false;
    this.onStatus = noop;
    this.onMessage = noop;
    this.onError = noop;
    this.diagTimes = new Map();
    this.diagnosticsEnabled = false;
  }

  diagnostic(key, ...details) {
    if (!this.diagnosticsEnabled) return;
    const now = performance.now();
    const previous = this.diagTimes.get(key) || 0;
    if (now - previous < 3000) return;
    this.diagTimes.set(key, now);
    console.log('[VERA][signaling]', key, ...details);
  }

  status(value, detail = '') {
    try { this.onStatus(value, detail); } catch (error) {}
  }

  connect() {
    if (!this.url) return Promise.reject(new Error('No Vera signaling URL is configured.'));
    if (this.socket && this.socket.readyState === WebSocket.OPEN) return Promise.resolve();
    this.closed = false;
    return new Promise((resolve, reject) => {
      let settled = false;
      let socket;
      try { socket = this.socket = new WebSocket(this.url); }
      catch (error) { reject(error); return; }
      socket.onopen = () => {
        this.status('connected');
        if (!settled) { settled = true; resolve(); }
      };
      socket.onmessage = event => {
        const raw = String(event.data || '');
        try {
          const message = JSON.parse(raw);
          this.diagnostic('websocket-received', { type: message && message.type, bytes: raw.length, slot: message && message.slot });
          if (message && typeof message.type === 'string') this.onMessage(message);
          else this.diagnostic('websocket-message-invalid', { bytes: raw.length });
        } catch (error) {
          this.diagnostic('websocket-json-error', { bytes: raw.length, error: String(error) });
        }
      };
      socket.onerror = () => {
        const error = new Error('The Vera signaling server could not be reached.');
        this.onError(error);
        if (!settled) { settled = true; reject(error); }
      };
      socket.onclose = () => {
        this.socket = null;
        this.diagnostic('websocket-closed');
        this.diagnosticsEnabled = false;
        this.status('disconnected');
        if (!settled) {
          settled = true;
          reject(new Error('The Vera signaling server closed the connection.'));
        }
      };
    });
  }

  send(action, payload = {}) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return false;
    try {
      const encoded = JSON.stringify({ action, ...payload });
      this.socket.send(encoded);
      this.diagnostic('websocket-sent', { action, bytes: encoded.length, readyState: this.socket.readyState });
      return true;
    } catch (error) {
      this.onError(error);
      return false;
    }
  }

  close() {
    this.closed = true;
    this.diagnosticsEnabled = false;
    try { this.socket && this.socket.close(); } catch (error) {}
    this.socket = null;
  }
}

export class VeraRoomTransport {
  constructor(url) {
    this.client = new VeraSignalingClient(url);
    this.onStatus = noop;
    this.onRoom = noop;
    this.onPeer = noop;
    this.onState = noop;
    this.onControl = noop;
    this.onError = noop;
    this.roomWaiter = null;
    this.client.onStatus = (status, detail) => this.onStatus(status, detail);
    this.client.onError = error => this.onError(error);
    this.client.onMessage = message => this.handleMessage(message);
  }

  async join(role, code = '') {
    await this.client.connect();
    const action = role === 'host' ? 'create' : 'join';
    const payload = role === 'host' ? {} : { code: String(code || '').toUpperCase() };
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.roomWaiter = null;
        reject(new Error('The room server did not confirm the room in time.'));
      }, 10000);
      this.roomWaiter = { resolve: message => { window.clearTimeout(timer); this.roomWaiter = null; resolve(message); }, reject };
      if (!this.client.send(action, payload)) {
        window.clearTimeout(timer);
        this.roomWaiter = null;
        reject(new Error('The room server is not ready.'));
      }
    });
  }

  handleMessage(message) {
    if (!message || typeof message.type !== 'string') return;
    this.client.diagnostic('message-processing', { type: message.type, slot: message.slot, dataType: message.data && message.data.type });
    if (message.type === 'room-created' || message.type === 'room-joined') {
      if (this.roomWaiter) this.roomWaiter.resolve(message);
      this.onRoom(message);
      this.onPeer({ connected: true, initial: true, ...message });
      return;
    }
    if (message.type === 'player-joined') {
      this.onPeer({ connected: true, joined: true, ...message });
      return;
    }
    if (message.type === 'player-left') {
      this.onPeer({ connected: false, left: true, ...message });
      return;
    }
    if (message.type === 'room-closed') {
      this.onPeer({ connected: false, closed: true, ...message });
      return;
    }
    if (message.type === 'state') {
      const packet = base64ToArrayBuffer(message.data);
      this.client.diagnostic(packet ? 'state-packet-decoded' : 'state-packet-decode-failed', { fromSlot: message.slot, bytes: packet && packet.byteLength, encodedBytes: message.data && message.data.length });
      if (packet) this.onState(packet, Number(message.slot));
      return;
    }
    if (message.type === 'control' && message.data && typeof message.data.type === 'string') {
      this.onControl(message.data, Number(message.slot));
      return;
    }
    if (message.type === 'error') this.onError(new Error(String(message.message || 'Room server error.')));
  }

  sendState(packet) {
    return this.client.send('state', { data: bytesToBase64(packet) });
  }

  sendControl(message) {
    if (!message || typeof message.type !== 'string') return false;
    const sent = this.client.send('control', { data: message });
    if (!sent) this.onError(new Error('The room connection is not ready for control data.'));
    return sent;
  }

  close() {
    this.client.send('leave');
    this.client.close();
  }
}
