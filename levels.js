/* ==========================================================================
   levels.js — level manifest
   --------------------------------------------------------------------------
   Under the standalone-HTML-per-level architecture, a "level" is a full,
   self-contained page (its own <script> block sets window.Level = { WIDTH,
   HEIGHT, spawnPoint, build } — see any level page for the exact shape).
   There is nothing left for this file to fetch or swap in: each page
   already IS its level. All this file owns now is the index -> {url,
   title} mapping the level-select grid renders from, and that lobby.js's
   navigation hand-off resolves an index to when it sends the room to the
   next page. See netcode.js's HANDOFF CONTRACT comment for how that's used.

   Levels are referenced by INDEX everywhere else in the lobby/network
   protocol (progress counts, `unlocked` in the lobby snapshot, the
   `select`/`starting`/`welcome`/`complete` messages in netcode.js) — never
   by id or url, to keep the wire format small and stable even if a page
   gets renamed/moved. `id`/`name`/`url` here are UI/navigation-only.

   Edit this list to add/reorder levels. Index in this array === level
   index used everywhere else. Reordering existing entries changes what
   index N means for players with existing progress — append, don't
   reorder, once this ships.

   PLACEHOLDER URLS: filled in with a guessed naming convention
   (levels/NN-id.html) matching the six levels already designed per project
   notes (Tutorial, Gears, Seesaw, Arrow Gap, Popcorn Row, Bounce Box).
   These need to be swapped for whatever the level-design chat actually
   named the files — grep for `window.Level =` under levels/ to confirm,
   or ask that chat directly.
   ========================================================================== */
(function () {
"use strict";

const ORDER = [
  // Index 0 is the only level that actually exists as a page right now —
  // level1-arrowgap.html, built to the standalone-level pattern. The rest
  // are still placeholders; a tile whose page is missing will fail loudly
  // in urlFor() rather than navigating to 'undefined', and the lobby shows
  // that as a status message instead of a dead link.
  { id: 'arrowgap',   name: 'Arrow Gap',    url: 'level1.html' },
  { id: 'popcornrow', name: 'Popcorn Row',  url: 'levels/02-popcornrow.html' },
  { id: 'bouncebox',  name: 'Bounce Box',   url: 'levels/03-bouncebox.html' },
];

window.Levels = {
  order: ORDER,
  count: ORDER.length,
  /** Index -> url, with a bounds check so a bad index fails loudly instead
   *  of navigating to 'undefined'. */
  urlFor(index) {
    const lvl = ORDER[index];
    if (!lvl) throw new Error('levels.js: bad level index ' + index);
    return lvl.url;
  },
};
})();