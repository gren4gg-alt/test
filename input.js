/* ==========================================================================
   input.js — input abstraction layer
   --------------------------------------------------------------------------
   Combines keyboard and touch (or any future source — gamepad, a second
   local player's controls, etc.) into one plain state object:

       { left: bool, right: bool, jump: bool, action: bool }

   Game code only ever reads InputManager#getState() and never touches
   keyboard/touch APIs directly. That's the whole point: swapping or adding
   an input source (touch buttons today, maybe a gamepad or an on-screen
   joystick later) never requires touching engine.js or the game loop.

   Usage:
     const input = new InputManager();
     bindTouchButton(document.getElementById('btnLeft'), input, 'left');
     bindTouchButton(document.getElementById('btnRight'), input, 'right');
     bindTouchButton(document.getElementById('btnJump'), input, 'jump');
     ...
     player.handleInput(input.getState(), dt);

   Plain <script src="input.js">, not a module — same reasoning as
   engine.js (opens straight from disk, no build step). Wrapped in an IIFE
   so nothing but window.InputManager / window.bindTouchButton leaks into
   the global scope.
   ========================================================================== */
(function () {

class InputManager {
  constructor() {
    // Each source maintains its own {left,right,jump} booleans; getState()
    // ORs them together so e.g. keyboard-left and touch-left both work,
    // including simultaneously (handy for testing touch UI with a mouse
    // while a keyboard is also attached).
    this._sources = {
      keyboard: { left: false, right: false, jump: false, action: false },
      touch:    { left: false, right: false, jump: false, action: false },
    };
    this._bindKeyboard();
  }

  _bindKeyboard() {
    const held = new Set();
    const sync = () => {
      const kb = this._sources.keyboard;
      kb.left   = held.has('ArrowLeft')  || held.has('KeyA');
      kb.right  = held.has('ArrowRight') || held.has('KeyD');
      kb.jump   = held.has('ArrowUp')    || held.has('KeyW') || held.has('Space');
      kb.action = held.has('KeyE')       || held.has('KeyF');
    };
    window.addEventListener('keydown', (e) => {
      held.add(e.code);
      if (e.code === 'Space') e.preventDefault(); // stop the page from scrolling
      sync();
    });
    window.addEventListener('keyup', (e) => {
      held.delete(e.code);
      sync();
    });
    // If the window/tab loses focus mid-press, the matching keyup never
    // fires — the key would appear stuck held forever. Clear everything.
    window.addEventListener('blur', () => { held.clear(); sync(); });
  }

  /** Touch (or any other custom source) calls this to report state. */
  setSource(sourceName, key, pressed) {
    if (!this._sources[sourceName]) this._sources[sourceName] = { left: false, right: false, jump: false, action: false };
    this._sources[sourceName][key] = pressed;
  }

  /** Returns the merged {left, right, jump, action} state for this frame. */
  getState() {
    const out = { left: false, right: false, jump: false, action: false };
    for (const name in this._sources) {
      const s = this._sources[name];
      out.left   = out.left   || s.left;
      out.right  = out.right  || s.right;
      out.jump   = out.jump   || s.jump;
      out.action = out.action || s.action;
    }
    return out;
  }
}

/**
 * Wire a DOM element up as a touch (and mouse, for desktop testing of the
 * touch UI) button that drives one key of `inputManager`'s "touch" source.
 * Supports multi-touch naturally since each element gets its own listeners
 * — the browser dispatches touch events per-element regardless of how many
 * fingers are down elsewhere.
 */
function bindTouchButton(el, inputManager, key) {
  if (!el) return;

  const setPressed = (pressed) => (e) => {
    e.preventDefault();
    inputManager.setSource('touch', key, pressed);
    el.classList.toggle('pressed', pressed);
  };

  el.addEventListener('touchstart', setPressed(true), { passive: false });
  el.addEventListener('touchend', setPressed(false), { passive: false });
  el.addEventListener('touchcancel', setPressed(false), { passive: false });

  // Mouse fallback so the same on-screen buttons are testable with a
  // mouse on desktop (useful for developing/verifying the touch UI
  // without a phone in hand).
  el.addEventListener('mousedown', setPressed(true));
  el.addEventListener('mouseup', setPressed(false));
  el.addEventListener('mouseleave', setPressed(false));
}

window.InputManager = InputManager;
window.bindTouchButton = bindTouchButton;

})();