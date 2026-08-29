/**
 * voicechat.js
 * ------------------------------------------------------------------
 * Standalone, drop-in voice chat module for PeerJS-based games.
 *
 * Full-mesh voice: every peer opens a direct MediaConnection to every
 * other peer. No dependency on any game's data channel, sync logic,
 * or entity system — this module only ever needs peer IDs to call.
 *
 * You bring your own already-created PeerJS `Peer` instance (this
 * module does not create or manage signaling/data connections).
 *
 * USAGE
 * -----
 *   const peer = new Peer(myId, { config: { iceServers: VoiceChat.RECOMMENDED_ICE_SERVERS } });
 *   peer.on('open', async () => {
 *     await VoiceChat.init(peer, {
 *       pushToTalk: false,
 *       onSpeakingChange: (peerId, speaking) => { ... },
 *       onPeerConnected:  (peerId) => { ... },
 *       onPeerDisconnected: (peerId) => { ... },
 *       onError: (err) => { ... },
 *     });
 *     VoiceChat.connectToPeers(['peerA', 'peerB']); // mesh formation
 *   });
 *
 *   // later, when the roster changes:
 *   VoiceChat.addPeer('peerC');
 *   VoiceChat.removePeer('peerB');
 *
 *   VoiceChat.toggleMute();
 *   VoiceChat.setPushToTalk(true);
 *   VoiceChat.setPeerVolume('peerA', 0.5);
 *   VoiceChat.mutePeer('peerA');
 *
 *   VoiceChat.disconnect(); // full teardown
 *
 * REQUIRES
 * --------
 *   - PeerJS loaded via CDN before this script:
 *     <script src="https://unpkg.com/peerjs@1.5.4/dist/peerjs.min.js"></script>
 *   - HTTPS or localhost (getUserMedia hard requirement — same as your
 *     existing GitHub Pages deployment, so this is already satisfied).
 *
 * IMPORTANT — TURN SERVERS
 * -------------------------
 * A meaningful share of direct P2P connections fail on strict NATs /
 * mobile carrier networks with STUN alone. This module does not
 * create the Peer object, so TURN config must be supplied by YOU when
 * constructing your Peer. A free-tier TURN list is exported below as
 * `VoiceChat.RECOMMENDED_ICE_SERVERS` (Open Relay Project) — pass it
 * into `new Peer(id, { config: { iceServers: ... } })`. STUN-only is
 * fine for initial testing between friends on decent networks, but
 * wire in TURN before relying on this across arbitrary mobile networks.
 *
 * IOS SAFARI NOTES
 * -----------------
 *   - Autoplay of remote <audio> elements can be blocked until a user
 *     gesture occurs. This module attaches audio elements muted+hidden
 *     and attempts .play() on connection; if that rejects (common on
 *     iOS before any tap), it retries lazily on the next pointerdown/
 *     touchend anywhere in the document (see _unlockAudioOnGesture).
 *   - getUserMedia on iOS Safari can silently return a track that
 *     reports "live" but is actually still gathering permission UI;
 *     always gate mesh-calling on the resolved local stream, not just
 *     "permission requested".
 *   - iOS Safari's AudioContext starts "suspended" until a gesture;
 *     the speaking-indicator AnalyserNode is created lazily/resumed
 *     on the same gesture unlock path.
 */

var VoiceChat = (function () {
  'use strict';

  // ---- Public constant: free STUN+TURN fallback (Open Relay Project) ----
  // Pass this into your own `new Peer(id, { config: { iceServers } })`.
  const RECOMMENDED_ICE_SERVERS = [
    { urls: 'stun:stun.relay.metered.ca:80' },
    {
      urls: 'turn:global.relay.metered.ca:80',
      username: 'openrelayproject',
      credential: 'openrelayproject',
    },
    {
      urls: 'turn:global.relay.metered.ca:443',
      username: 'openrelayproject',
      credential: 'openrelayproject',
    },
    {
      urls: 'turn:global.relay.metered.ca:443?transport=tcp',
      username: 'openrelayproject',
      credential: 'openrelayproject',
    },
  ];

  // ---- Internal state ----
  let _peer = null;               // the caller-supplied PeerJS Peer instance
  let _localStream = null;        // our mic MediaStream
  let _micEnabledIntent = true;   // "would be on if not for push-to-talk gating"
  let _pushToTalkActive = false;  // true while PTT key/button is held
  let _pushToTalkMode = false;    // whether PTT is the active mode
  let _pushToTalkKey = 'Space';   // KeyboardEvent.code
  let _initialized = false;
  let _audioCtx = null;
  let _audioCtxUnlocked = false;

  // per-peer entry: { call, stream, audioEl, gainNode, analyser, sourceNode,
  //                   volume, mutedLocally, speaking, rafId }
  const _peers = new Map();

  // callbacks (all optional)
  let _cb = {
    onSpeakingChange: function () {},
    onPeerConnected: function () {},
    onPeerDisconnected: function () {},
    onError: function () {},
    onMicPermissionDenied: function () {},
  };

  const SPEAKING_THRESHOLD = 0.02;   // rms threshold, tune per mic
  const SPEAKING_HYSTERESIS_MS = 200; // avoid flicker

  // ------------------------------------------------------------------
  // Init / mic permission
  // ------------------------------------------------------------------

  /**
   * @param {Peer} peer - an already-created, already-open PeerJS Peer.
   * @param {Object} [options]
   * @param {boolean} [options.pushToTalk=false]
   * @param {string}  [options.pushToTalkKey='Space'] - KeyboardEvent.code
   * @param {function} [options.onSpeakingChange] (peerId, isSpeaking)
   * @param {function} [options.onPeerConnected] (peerId)
   * @param {function} [options.onPeerDisconnected] (peerId)
   * @param {function} [options.onError] (error)
   * @param {function} [options.onMicPermissionDenied] ()
   * @returns {Promise<void>} resolves once mic access is granted and
   *          incoming-call handling is wired up. Rejects if mic access
   *          is denied — caller should show a fallback/error UI.
   */
  function init(peer, options) {
    if (_initialized) {
      console.warn('[VoiceChat] already initialized; call disconnect() first');
    }
    options = options || {};
    _peer = peer;
    _pushToTalkMode = !!options.pushToTalk;
    _pushToTalkKey = options.pushToTalkKey || 'Space';
    Object.assign(_cb, options);

    _unlockAudioOnGesture();

    return _requestMic()
      .then(function (stream) {
        _localStream = stream;
        _applyMicGate(); // enforce initial mute/PTT state on the track

        _peer.on('call', _handleIncomingCall);
        _peer.on('disconnected', function () {
          _cb.onError(new Error('[VoiceChat] underlying peer connection lost'));
        });

        if (_pushToTalkMode) _wirePushToTalkKey();

        _initialized = true;
      })
      .catch(function (err) {
        _cb.onMicPermissionDenied();
        _cb.onError(err);
        throw err;
      });
  }

  function _requestMic() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      return Promise.reject(new Error('[VoiceChat] getUserMedia unsupported (needs HTTPS or localhost)'));
    }
    return navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: false,
    });
  }

  // ------------------------------------------------------------------
  // Mesh formation
  // ------------------------------------------------------------------

  /** Connect to every peer ID in the given roster (mesh formation). */
  // Pending outbound dials held back by glare avoidance: peerId -> timeoutId.
  const _pendingDial = new Map();
  const GLARE_FALLBACK_MS = 1500;

  function connectToPeers(peerIds) {
    _assertInit();
    (peerIds || []).forEach(addPeer);
  }

  /** Open a MediaConnection to a single peer (idempotent).
   *
   *  GLARE: the mesh is symmetric, so if both sides call addPeer() for each
   *  other at the same moment, two MediaConnections exist for one pair. That
   *  used to produce one-way audio (see _handleIncomingCall). To stop the
   *  collision happening at all, only ONE side dials: the peer whose id sorts
   *  lower. Both sides compute the same answer from ids alone, so no
   *  coordination is needed.
   *
   *  The higher-id side waits to be called instead — but not forever. If the
   *  other end never dials (it added us late, its roster was stale, or it is
   *  running an older build of this file), GLARE_FALLBACK_MS later we dial
   *  anyway. A duplicate call is now handled correctly, so the fallback is
   *  safe even if it races.
   */
  function addPeer(peerId) {
    _assertInit();
    if (!peerId || peerId === _peer.id || _peers.has(peerId)) return;

    if (_peer.id < peerId) {
      _dial(peerId);
    } else if (!_pendingDial.has(peerId)) {
      _pendingDial.set(peerId, setTimeout(function () {
        _pendingDial.delete(peerId);
        if (!_peers.has(peerId)) _dial(peerId);   // they never called us
      }, GLARE_FALLBACK_MS));
    }
  }

  function _dial(peerId) {
    if (_peers.has(peerId)) return;
    const call = _peer.call(peerId, _localStream, {
      metadata: { voicechat: true },
    });
    if (!call) {
      _cb.onError(new Error('[VoiceChat] peer.call() failed for ' + peerId + ' (peer not open yet?)'));
      return;
    }
    _registerCall(peerId, call);
  }

  function _clearPendingDial(peerId) {
    const t = _pendingDial.get(peerId);
    if (t) { clearTimeout(t); _pendingDial.delete(peerId); }
  }

  /** Close and remove a peer's voice connection (e.g. they left the room). */
  function removePeer(peerId) {
    _clearPendingDial(peerId);
    const entry = _peers.get(peerId);
    if (!entry) return;
    _teardownEntry(entry);
    _peers.delete(peerId);
    _cb.onPeerDisconnected(peerId);
  }

  function _handleIncomingCall(call) {
    _assertInit();
    _clearPendingDial(call.peer);   // they dialled first; drop our fallback

    const existing = _peers.get(call.peer);

    // "First successful STREAM wins" — decided on the stream, not on which
    // call object showed up first. The old code returned early whenever an
    // entry existed, even one that had never produced audio, so an outbound
    // call that stalled would permanently shadow a working inbound one. That
    // is what made the host hear nothing while clients heard the host.
    if (existing && existing.stream) {
      call.answer(_localStream);    // already have working audio; be polite
      return;
    }
    if (existing) {
      // Entry exists but is silent — replace it with this call.
      _teardownEntry(existing);
      _peers.delete(call.peer);
    }

    call.answer(_localStream);
    _registerCall(call.peer, call);
  }

  function _registerCall(peerId, call) {
    const entry = {
      call: call,
      stream: null,
      audioEl: null,
      gainNode: null,
      analyser: null,
      sourceNode: null,
      volume: 1.0,
      mutedLocally: false,
      speaking: false,
      speakingRafId: null,
      lastSpeakingChangeAt: 0,
    };
    _peers.set(peerId, entry);

    call.on('stream', function (remoteStream) {
      entry.stream = remoteStream;
      _attachRemoteAudio(peerId, entry, remoteStream);
      _cb.onPeerConnected(peerId);
    });

    call.on('close', function () {
      removePeer(peerId);
    });

    call.on('error', function (err) {
      _cb.onError(new Error('[VoiceChat] call error with ' + peerId + ': ' + err.message));
      removePeer(peerId);
    });
  }

  function _attachRemoteAudio(peerId, entry, remoteStream) {
    // <audio> element for actual playback (simplest path across
    // browsers, incl. iOS quirks around raw AudioContext output).
    const audioEl = document.createElement('audio');
    audioEl.autoplay = true;
    audioEl.playsInline = true; // iOS Safari
    audioEl.srcObject = remoteStream;
    audioEl.dataset.voicechatPeer = peerId;
    audioEl.style.display = 'none';
    document.body.appendChild(audioEl);
    entry.audioEl = audioEl;

    const playPromise = audioEl.play();
    if (playPromise && playPromise.catch) {
      playPromise.catch(function () {
        // Blocked by autoplay policy (common on iOS before a gesture).
        // _unlockAudioOnGesture will retry this on next tap.
        entry.audioEl._pendingPlay = true;
      });
    }

    // Web Audio graph for per-peer volume control + speaking detection.
    // Route through a GainNode so setPeerVolume/mutePeer work without
    // touching the <audio> element's own volume (keeps one source of truth).
    _ensureAudioCtx();
    try {
      const source = _audioCtx.createMediaStreamSource(remoteStream);
      const gain = _audioCtx.createGain();
      gain.gain.value = entry.mutedLocally ? 0 : entry.volume;
      const analyser = _audioCtx.createAnalyser();
      analyser.fftSize = 512;
      source.connect(gain);
      gain.connect(analyser);
      // Deliberately NOT connecting gain -> audioCtx.destination:
      // the <audio> element already plays the raw stream. We only use
      // this graph for volume gating (mirrored onto audioEl.volume
      // below) and speaking analysis, avoiding double playback.
      entry.sourceNode = source;
      entry.gainNode = gain;
      entry.analyser = analyser;
      audioEl.volume = entry.mutedLocally ? 0 : entry.volume;
      _startSpeakingDetection(peerId, entry);
    } catch (err) {
      _cb.onError(new Error('[VoiceChat] audio graph setup failed for ' + peerId + ': ' + err.message));
    }
  }

  function _teardownEntry(entry) {
    if (entry.speakingRafId) cancelAnimationFrame(entry.speakingRafId);
    if (entry.call) {
      try { entry.call.close(); } catch (e) {}
    }
    if (entry.sourceNode) try { entry.sourceNode.disconnect(); } catch (e) {}
    if (entry.gainNode) try { entry.gainNode.disconnect(); } catch (e) {}
    if (entry.analyser) try { entry.analyser.disconnect(); } catch (e) {}
    if (entry.audioEl) {
      entry.audioEl.srcObject = null;
      entry.audioEl.remove();
    }
  }

  // ------------------------------------------------------------------
  // Speaking (audio level) detection
  // ------------------------------------------------------------------

  function _startSpeakingDetection(peerId, entry) {
    const analyser = entry.analyser;
    const data = new Uint8Array(analyser.fftSize);

    function tick() {
      if (!_peers.has(peerId)) return; // torn down
      analyser.getByteTimeDomainData(data);
      let sumSquares = 0;
      for (let i = 0; i < data.length; i++) {
        const v = (data[i] - 128) / 128;
        sumSquares += v * v;
      }
      const rms = Math.sqrt(sumSquares / data.length);
      const now = performance.now();
      const isSpeaking = rms > SPEAKING_THRESHOLD && !entry.mutedLocally;

      if (isSpeaking !== entry.speaking && (now - entry.lastSpeakingChangeAt) > SPEAKING_HYSTERESIS_MS) {
        entry.speaking = isSpeaking;
        entry.lastSpeakingChangeAt = now;
        _cb.onSpeakingChange(peerId, isSpeaking);
      }
      entry.speakingRafId = requestAnimationFrame(tick);
    }
    entry.speakingRafId = requestAnimationFrame(tick);
  }

  function _ensureAudioCtx() {
    if (_audioCtx) return;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    _audioCtx = new Ctx();
  }

  // Unlock <audio> playback + resume AudioContext on first user gesture,
  // required for iOS Safari's autoplay/AudioContext-suspended behavior.
  function _unlockAudioOnGesture() {
    if (_audioCtxUnlocked) return;
    function unlock() {
      if (_audioCtx && _audioCtx.state === 'suspended') {
        _audioCtx.resume().catch(function () {});
      }
      _peers.forEach(function (entry) {
        if (entry.audioEl && entry.audioEl._pendingPlay) {
          entry.audioEl.play().then(function () {
            entry.audioEl._pendingPlay = false;
          }).catch(function () {});
        }
      });
      _audioCtxUnlocked = true;
      document.removeEventListener('pointerdown', unlock);
      document.removeEventListener('touchend', unlock);
      document.removeEventListener('keydown', unlock);
    }
    document.addEventListener('pointerdown', unlock);
    document.addEventListener('touchend', unlock);
    document.addEventListener('keydown', unlock);
  }

  // ------------------------------------------------------------------
  // Mute / push-to-talk
  // ------------------------------------------------------------------

  function mute() {
    _micEnabledIntent = false;
    _applyMicGate();
  }

  function unmute() {
    _micEnabledIntent = true;
    _applyMicGate();
  }

  function toggleMute() {
    _micEnabledIntent ? mute() : unmute();
  }

  function isMuted() {
    return !_micEnabledIntent;
  }

  /** Enable/disable push-to-talk mode. When enabled, mic is gated by
   *  the PTT key/button rather than the mute toggle's on/off intent. */
  function setPushToTalk(enabled) {
    _pushToTalkMode = !!enabled;
    _pushToTalkActive = false;
    if (_pushToTalkMode) {
      _wirePushToTalkKey();
    } else {
      _unwirePushToTalkKey();
    }
    _applyMicGate();
  }

  function setPushToTalkKey(code) {
    _pushToTalkKey = code;
  }

  /** For a custom PTT button (touch UI) instead of/alongside the key. */
  function pushToTalkStart() {
    if (!_pushToTalkMode) return;
    _pushToTalkActive = true;
    _applyMicGate();
  }

  function pushToTalkEnd() {
    if (!_pushToTalkMode) return;
    _pushToTalkActive = false;
    _applyMicGate();
  }

  function _onKeyDown(e) {
    if (e.code === _pushToTalkKey && !_pushToTalkActive) {
      _pushToTalkActive = true;
      _applyMicGate();
    }
  }
  function _onKeyUp(e) {
    if (e.code === _pushToTalkKey) {
      _pushToTalkActive = false;
      _applyMicGate();
    }
  }
  function _wirePushToTalkKey() {
    document.addEventListener('keydown', _onKeyDown);
    document.addEventListener('keyup', _onKeyUp);
  }
  function _unwirePushToTalkKey() {
    document.removeEventListener('keydown', _onKeyDown);
    document.removeEventListener('keyup', _onKeyUp);
  }

  /** Applies current mute/PTT intent to the actual local audio track. */
  function _applyMicGate() {
    if (!_localStream) return;
    const shouldTransmit = _pushToTalkMode ? _pushToTalkActive : _micEnabledIntent;
    _localStream.getAudioTracks().forEach(function (track) {
      track.enabled = shouldTransmit;
    });
  }

  // ------------------------------------------------------------------
  // Per-peer controls
  // ------------------------------------------------------------------

  function setPeerVolume(peerId, volume) {
    const entry = _peers.get(peerId);
    if (!entry) return;
    entry.volume = Math.max(0, Math.min(1, volume));
    if (!entry.mutedLocally) {
      if (entry.gainNode) entry.gainNode.gain.value = entry.volume;
      if (entry.audioEl) entry.audioEl.volume = entry.volume;
    }
  }

  function mutePeer(peerId) {
    const entry = _peers.get(peerId);
    if (!entry) return;
    entry.mutedLocally = true;
    if (entry.gainNode) entry.gainNode.gain.value = 0;
    if (entry.audioEl) entry.audioEl.volume = 0;
  }

  function unmutePeer(peerId) {
    const entry = _peers.get(peerId);
    if (!entry) return;
    entry.mutedLocally = false;
    if (entry.gainNode) entry.gainNode.gain.value = entry.volume;
    if (entry.audioEl) entry.audioEl.volume = entry.volume;
  }

  function isPeerMuted(peerId) {
    const entry = _peers.get(peerId);
    return entry ? entry.mutedLocally : false;
  }

  function isPeerSpeaking(peerId) {
    const entry = _peers.get(peerId);
    return entry ? entry.speaking : false;
  }

  function connectedPeerIds() {
    return Array.from(_peers.keys());
  }

  // ------------------------------------------------------------------
  // Teardown
  // ------------------------------------------------------------------

  function disconnect() {
    _pendingDial.forEach(function (t) { clearTimeout(t); });
    _pendingDial.clear();
    _peers.forEach(_teardownEntry);
    _peers.clear();

    if (_localStream) {
      _localStream.getTracks().forEach(function (t) { t.stop(); });
      _localStream = null;
    }
    if (_audioCtx) {
      try { _audioCtx.close(); } catch (e) {}
      _audioCtx = null;
      _audioCtxUnlocked = false;
    }
    _unwirePushToTalkKey();

    if (_peer) {
      _peer.off('call', _handleIncomingCall);
    }
    _peer = null;
    _initialized = false;
    _micEnabledIntent = true;
    _pushToTalkActive = false;
  }

  function _assertInit() {
    if (!_initialized) {
      throw new Error('[VoiceChat] not initialized — call VoiceChat.init(peer, options) first');
    }
  }

  // ------------------------------------------------------------------
  return {
    RECOMMENDED_ICE_SERVERS: RECOMMENDED_ICE_SERVERS,
    init: init,
    connectToPeers: connectToPeers,
    addPeer: addPeer,
    removePeer: removePeer,
    mute: mute,
    unmute: unmute,
    toggleMute: toggleMute,
    isMuted: isMuted,
    setPushToTalk: setPushToTalk,
    setPushToTalkKey: setPushToTalkKey,
    pushToTalkStart: pushToTalkStart,
    pushToTalkEnd: pushToTalkEnd,
    setPeerVolume: setPeerVolume,
    mutePeer: mutePeer,
    unmutePeer: unmutePeer,
    isPeerMuted: isPeerMuted,
    isPeerSpeaking: isPeerSpeaking,
    connectedPeerIds: connectedPeerIds,
    disconnect: disconnect,
  };
})();
