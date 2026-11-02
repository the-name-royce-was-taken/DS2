/*
 * Static deployment configuration for Vera LAN multiplayer.
 *
 * The checked-in endpoint is the currently running Cloudflare Quick Tunnel
 * for the Python room server. `?signal=` still overrides it for local testing
 * or after the temporary tunnel is replaced. The original manual WebRTC
 * fallback remains available if the room server cannot be reached.
 * The public STUN entries only help browsers discover a usable route when the
 * players are on different Wi-Fi networks; they never carry game state.
 */
(function configureVeraNetwork() {
  'use strict';

  var existing = window.VERA_NETWORK_CONFIG || {};
  var querySignaling = '';
  try { querySignaling = new URLSearchParams(window.location.search).get('signal') || ''; } catch (error) {}
  var defaultSignaling = 'wss://ds-2-defailt-server-1--roycedev.replit.app/signal';
  var configuredIce = Array.isArray(existing.iceServers) ? existing.iceServers : [];
  var defaultIce = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ];
  window.VERA_NETWORK_CONFIG = Object.freeze({
    iceServers: configuredIce.length ? configuredIce : defaultIce,
    signalingUrl: String(querySignaling || existing.signalingUrl || defaultSignaling).trim(),
    maxPlayers: 20
  });
})();
