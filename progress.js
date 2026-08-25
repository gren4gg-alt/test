/* ==========================================================================
   progress.js — per-device level progress
   --------------------------------------------------------------------------
   Matches the rest of the project's static, no-server approach: progress
   lives in localStorage on this device only. There is no account system,
   so "progress" means "levels this browser/device has completed", full
   stop. Syncing what that means for a ROOM (multiple devices with
   different progress) is the lobby/host's job, not this file's — see
   netcode.js Host.recomputeLobby(), which is the one place that decides
   what a group is allowed to play.
   ========================================================================== */
(function () {
"use strict";

const KEY = 'doubletrouble.progress.v1';

function read() {
  try {
    const raw = localStorage.getItem(KEY);
    const n = raw === null ? 0 : JSON.parse(raw);
    return Number.isInteger(n) && n >= 0 ? n : 0;
  } catch {
    return 0; // storage unavailable (private browsing, quota, etc.) -> nothing unlocked
  }
}

function write(n) {
  try { localStorage.setItem(KEY, JSON.stringify(Math.max(0, n | 0))); } catch {}
}

const Progress = {
  /** Number of levels completed on this device (0-based count, e.g. 2
   *  means levels 0 and 1 are done and level 2 is the next one to unlock). */
  get() { return read(); },

  /** Call when the LOCAL player finishes level index `levelIdx` (0-based).
   *  Monotonic — a lower report never regresses stored progress, so
   *  replaying an earlier level doesn't undo real progress. */
  markComplete(levelIdx) {
    const next = Math.max(read(), (levelIdx | 0) + 1);
    write(next);
    return next;
  },

  /** Debug / "reset save" affordance. Not wired to any UI by default. */
  reset() { write(0); },
};

window.Progress = Progress;
})();