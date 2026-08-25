/* ==========================================================================
   voicechat-adapter.js
   --------------------------------------------------------------------------
   voicechat.js is headless (mesh calling, mute, per-peer volume/mute,
   RMS speaking detection — no UI, no getters for a few things it doesn't
   need internally). This file is a thin STATE layer on top of it:
   normalizes what it can query directly, tracks the handful of things it
   can't (per-peer volume has no getter; push-to-talk mode/active state
   has no getter either), and fires a single onChange event any consumer
   can subscribe to. It builds no DOM — that's lobby.js's job, since it's
   the one that already knows slot/color/peerId mapping for rendering.

   PUSH-TO-TALK KEY: voicechat.js defaults to 'Space', which collides
   with input.js's jump binding. Repointed to 'KeyV' in init() below.
   ========================================================================== */
(function () {
"use strict";

const hasReal = typeof window.VoiceChat === 'object'
  && window.VoiceChat !== null
  && typeof window.VoiceChat.init === 'function';

if (!hasReal) {
  console.warn('[voicechat-adapter] voicechat.js not found — VoiceUI will report as unsupported. ' +
               'Make sure <script src="voicechat.js"> is included before voicechat-adapter.js in lobby.html.');
}

const PTT_KEY = 'KeyV'; // avoids colliding with input.js's Space=jump binding

let _ready = false;
let _wantSet = new Set();                 // last roster passed to sync(), minus self
const _peerState = new Map();              // peerId -> { status: 'connecting'|'connected'|'error', volume: 0..1 }
let _pttMode = false;
let _pttActive = false;
const _listeners = [];

function fireChange() {
  for (const fn of _listeners) { try { fn(); } catch (e) { console.error('[voicechat-adapter] onChange listener threw:', e); } }
}

function peerEntry(id) {
  let e = _peerState.get(id);
  if (!e) { e = { status: 'connecting', volume: 1 }; _peerState.set(id, e); }
  return e;
}

// Mirrors voicechat.js's OWN keydown/keyup PTT wiring, purely so the UI
// reflects physical-key presses too, not just the on-screen button —
// voicechat.js gates the mic itself independently; this only updates
// what we show.
function _onPttKeyDown(e) { if (e.code === PTT_KEY && !_pttActive) { _pttActive = true; fireChange(); } }
function _onPttKeyUp(e)   { if (e.code === PTT_KEY) { _pttActive = false; fireChange(); } }
function _wirePttMirror()   { document.addEventListener('keydown', _onPttKeyDown); document.addEventListener('keyup', _onPttKeyUp); }
function _unwirePttMirror() { document.removeEventListener('keydown', _onPttKeyDown); document.removeEventListener('keyup', _onPttKeyUp); }

const VoiceUI = {
  isSupported() { return hasReal; },
  isReady() { return _ready; },

  async init(peer, opts) {
    if (!hasReal) return;
    opts = opts || {};
    window.VoiceChat.setPushToTalkKey(PTT_KEY);
    try {
      await window.VoiceChat.init(peer, {
        pushToTalk: false,
        onError: err => console.error('[voicechat]', err),
        onMicPermissionDenied: () => { _ready = false; fireChange(); },
        onPeerConnected: id => {
          peerEntry(id).status = 'connected';
          if (opts.onPeerConnected) opts.onPeerConnected(id);
          fireChange();
        },
        onPeerDisconnected: id => {
          // Still wanted -> the call itself failed/dropped (voicechat.js
          // fires this for both a clean close AND a call error). Not
          // wanted -> this is an intentional leave, already handled by
          // sync() below; just drop our tracking silently.
          if (_wantSet.has(id)) { peerEntry(id).status = 'error'; }
          else { _peerState.delete(id); }
          if (opts.onPeerDisconnected) opts.onPeerDisconnected(id);
          fireChange();
        },
        onSpeakingChange: (id, speaking) => {
          if (opts.onSpeakingChange) opts.onSpeakingChange(id, speaking);
          fireChange();
        },
      });
      _ready = true;
      fireChange();
    } catch (e) {
      // Already surfaced via onError/onMicPermissionDenied above.
    }
  },

  /** Roster is the FULL room's peer ids, including self — filtered here.
   *  Idempotent; call as often as the roster changes (or on a heartbeat —
   *  see lobby.js) to self-heal a dropped/errored connection. */
  sync(allPeerIds, selfId) {
    if (!hasReal || !_ready) return;
    const want = new Set((allPeerIds || []).filter(id => id !== selfId));
    const have = new Set(window.VoiceChat.connectedPeerIds());

    for (const id of want) {
      if (!have.has(id)) { window.VoiceChat.addPeer(id); peerEntry(id).status = 'connecting'; }
    }
    for (const id of have) {
      if (!want.has(id)) { window.VoiceChat.removePeer(id); _peerState.delete(id); }
    }
    for (const id of Array.from(_peerState.keys())) {
      if (!want.has(id)) _peerState.delete(id);
    }
    _wantSet = want;
    fireChange();
  },

  // ---- self ----
  isSelfMuted() { return hasReal && _ready ? window.VoiceChat.isMuted() : true; },
  toggleSelfMute() { if (!hasReal || !_ready) return; window.VoiceChat.toggleMute(); fireChange(); },

  getMode() { return _pttMode ? 'ptt' : 'always'; },
  setMode(mode) {
    if (!hasReal || !_ready) return;
    const ptt = mode === 'ptt';
    if (ptt === _pttMode) return;
    _pttMode = ptt;
    _pttActive = false;
    window.VoiceChat.setPushToTalk(ptt);
    if (ptt) _wirePttMirror(); else _unwirePttMirror();
    fireChange();
  },
  isPttActive() { return _pttActive; },
  pttStart() {
    if (!hasReal || !_ready || !_pttMode) return;
    window.VoiceChat.pushToTalkStart();
    _pttActive = true;
    fireChange();
  },
  pttEnd() {
    if (!hasReal || !_ready || !_pttMode) return;
    window.VoiceChat.pushToTalkEnd();
    _pttActive = false;
    fireChange();
  },

  // ---- peers ----
  /** 'connecting' | 'connected' | 'error' | 'idle' (not currently tracked) */
  getPeerStatus(id) { return _peerState.has(id) ? _peerState.get(id).status : 'idle'; },
  isPeerSpeaking(id) { return hasReal && _ready ? window.VoiceChat.isPeerSpeaking(id) : false; },
  isPeerLocallyMuted(id) { return hasReal && _ready ? window.VoiceChat.isPeerMuted(id) : false; },
  togglePeerMute(id) {
    if (!hasReal || !_ready) return;
    if (window.VoiceChat.isPeerMuted(id)) window.VoiceChat.unmutePeer(id);
    else window.VoiceChat.mutePeer(id);
    fireChange();
  },
  getPeerVolume(id) { return _peerState.has(id) ? _peerState.get(id).volume : 1; },
  setPeerVolume(id, vol) {
    if (!hasReal || !_ready) return;
    const v = Math.max(0, Math.min(1, vol));
    peerEntry(id).volume = v;
    window.VoiceChat.setPeerVolume(id, v);
    fireChange();
  },

  /** Subscribe to any state change (self mute/mode, peer status/speaking/
   *  volume). Returns an unsubscribe function. Fired synchronously after
   *  the change that caused it, so consumers can just re-render. */
  onChange(fn) {
    _listeners.push(fn);
    return () => { const i = _listeners.indexOf(fn); if (i >= 0) _listeners.splice(i, 1); };
  },
};

window.VoiceUI = VoiceUI;
})();