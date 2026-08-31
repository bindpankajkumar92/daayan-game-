/**
 * TouchControls — virtual joystick (left) + look-drag (right) + action buttons.
 * - Joystick: 112px ring, 52px knob; a touch anywhere on the left half spawns it under the thumb.
 * - Look: drag anywhere on the right half of the screen; sensitivity is settable (see setSensitivity).
 * - Action buttons: Interact (one-shot), Run (toggle), Crouch (toggle), Pause (one-shot).
 *
 * Desktop: WASD + pointer-lock mouse on the canvas. Esc releases.
 *
 * Emits a movement intent {strafe, forward, run, crouch} each frame via getMove().
 * Look deltas accumulate in a buffer; consume via consumeLookDelta().
 *
 * Three decisions here are load-bearing and easy to undo by accident:
 *
 * - **There is no LANTERN button.** The lantern is the player's only light and turning it off was never
 *   a choice anyone wanted to make — it was a fourth thing in the thumb column that dimmed the screen.
 *   The light itself stays lit; HouseScene passes a constant. The `f` key went with it.
 *
 * - **The buttons are styled from one injected stylesheet, not per-element inline styles.** Sixteen
 *   inline properties per button re-resolved on every toggle is the same paint the class swap does once,
 *   and the class is what lets `:active`-style press feedback live in CSS where it costs no JS. What is
 *   deliberately *not* used is `backdrop-filter`: it reads back the framebuffer behind the element every
 *   frame it is composited, over a canvas that is already the thing we are short of frames on.
 *
 * - **Look sensitivity is an instance field, not the old `private static readonly`.** The main menu sets
 *   it, so it has to be reachable; the static survives as the default and the clamp range.
 */

import type { FPController } from './FPController';
import type { DebugOverlay } from '@/core/DebugOverlay';

interface Button {
  el: HTMLButtonElement;
  label: string;
}

export class TouchControls {
  private root: HTMLDivElement;
  private sheet: HTMLStyleElement;
  private joystickBase: HTMLDivElement;
  private joystickKnob: HTMLDivElement;
  private moveSurface: HTMLDivElement;
  private lookSurface: HTMLDivElement;
  private buttons: Button[] = [];

  private joyTouchId: number | null = null;
  /** Screen-space origin of the current joystick drag (set on touchstart). */
  private joyOriginX = 0;
  private joyOriginY = 0;
  private lookTouchId: number | null = null;
  private lookLastX = 0;
  private lookLastY = 0;
  private lookDeltaX = 0;
  private lookDeltaY = 0;

  private strafe = 0;
  private forward = 0;
  private wantRun = false;
  private wantCrouch = false;
  private onInteract: () => void = () => {};
  private onPause: () => void = () => {};
  private onToggleDebug: () => void = () => {};

  /** The sensitivity the game shipped with, and the middle of the range the menu offers. */
  static readonly LOOK_DEFAULT = 0.0035;
  /**
   * What setSensitivity will accept. The low end is still usable for aiming down a hallway; the high end
   * is a full 180 in about a thumb's width of drag, which is as far as anyone asked to go.
   *
   * These three sit *above* `lookSens` rather than with the other statics further down because a field
   * initializer may not read a static declared after it (TS2729), and `lookSens` defaults to one.
   */
  static readonly LOOK_MIN = 0.0012;
  static readonly LOOK_MAX = 0.009;

  /**
   * Rad per pixel of drag, settable from the menu. Starts at the old constant so a player who never
   * opens settings gets exactly what shipped before.
   */
  private lookSens = TouchControls.LOOK_DEFAULT;

  /**
   * While true the stick, the look drag and the action buttons are all inert and the whole layer is
   * hidden. The menu overlay sits above this at z 9000 and would swallow the touches anyway; this is the
   * half that stops a *held* finger from steering the player behind the menu, which the overlay cannot
   * do because the touch was already latched when it appeared.
   */
  private paused = false;

  // Desktop state
  private keys = new Set<string>();
  private pointerLocked = false;

  private runBtn: HTMLButtonElement | null = null;
  private crouchBtn: HTMLButtonElement | null = null;

  private static readonly JOY_RADIUS = 56;
  static readonly MOVE_DEADZONE = 0.12;
  /** Top-left square reserved for the debug-overlay tap target. */
  private static readonly DEBUG_CORNER = 110;

  // Reserved for future use (controller for movement, debug for overlay triggers).
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  constructor(_controller: FPController, _debug: DebugOverlay) {
    this.sheet = injectButtonStyles();
    this.root = document.createElement('div');
    this.root.id = 'touch-controls';
    this.root.style.cssText = `
      position: fixed; inset: 0; pointer-events: none; z-index: 8000;
      user-select: none; -webkit-user-select: none; touch-action: none;
    `;
    document.body.appendChild(this.root);

    // Left-half move surface — a touch anywhere here spawns the joystick at that point.
    // A fixed 100px ring meant the thumb had to find it first; a dynamic origin is what
    // every mobile shooter does and it removes the "joystick ignored me" failure mode.
    this.moveSurface = document.createElement('div');
    this.moveSurface.style.cssText = `
      position: absolute; left: 0; top: 0; width: 50%; height: 100%;
      pointer-events: auto; touch-action: none;
    `;
    this.root.appendChild(this.moveSurface);

    // Right-half look surface — invisible, captures drag.
    this.lookSurface = document.createElement('div');
    this.lookSurface.style.cssText = `
      position: absolute; right: 0; top: 0; width: 50%; height: 100%;
      pointer-events: auto; touch-action: none;
    `;
    this.root.appendChild(this.lookSurface);

    this.joystickBase = this.makeJoystickBase();
    this.joystickKnob = this.makeJoystickKnob();
    this.joystickBase.appendChild(this.joystickKnob);
    this.root.appendChild(this.joystickBase);

    // Action buttons. The whole column moved into the bottom-right thumb arc, INTERACT lowest of the
    // three because it is the one pressed in a hurry: it used to sit in the top-right corner, which is
    // the furthest point on the screen from a thumb holding a phone in landscape. PAUSE takes the corner
    // it vacated — out of the play area on purpose, since a mis-tap there stops the game.
    // Inset from the right and bottom edges through env() so a notch or a gesture bar cannot clip them.
    const SIDE = 'calc(14px + env(safe-area-inset-right, 0px))';
    const btm = (n: number): string => `calc(${n}px + env(safe-area-inset-bottom, 0px))`;
    this.addButton('interact', 'INTERACT', '●', { right: SIDE, bottom: btm(14) }, () =>
      this.onInteract(),
    );
    this.runBtn = this.addButton('run', 'RUN', '»', { right: SIDE, bottom: btm(92) }, () => {
      this.wantRun = !this.wantRun;
      this.refreshToggleStyles();
    });
    this.crouchBtn = this.addButton(
      'crouch',
      'CROUCH',
      '▼',
      { right: SIDE, bottom: btm(170) },
      () => {
        this.wantCrouch = !this.wantCrouch;
        this.refreshToggleStyles();
      },
    );
    // Two CSS bars rather than a pause glyph. ❚❚ and ‖ are both outside the subset Roboto ships on some
    // Android builds, and a missing glyph is a tofu box on the one button that stops the game.
    this.addButton(
      'pause',
      'PAUSE',
      '<i class="tc-bar"></i><i class="tc-bar"></i>',
      { right: SIDE, top: 'calc(14px + env(safe-area-inset-top, 0px))' },
      () => this.onPause(),
    ).classList.add('tc-small');

    this.attachTouchHandlers();
    this.attachKeyboardHandlers();
    this.refreshToggleStyles();
  }

  setOnInteract(fn: () => void): void {
    this.onInteract = fn;
  }
  /** Called by the PAUSE button and by Esc / P on a keyboard. */
  setOnPause(fn: () => void): void {
    this.onPause = fn;
  }
  setOnToggleDebug(fn: () => void): void {
    this.onToggleDebug = fn;
  }

  /** Rad per pixel of look drag, clamped to LOOK_MIN..LOOK_MAX. The menu's slider writes this. */
  setSensitivity(radPerPx: number): void {
    const v = Number.isFinite(radPerPx) ? radPerPx : TouchControls.LOOK_DEFAULT;
    this.lookSens = Math.min(Math.max(v, TouchControls.LOOK_MIN), TouchControls.LOOK_MAX);
  }

  getSensitivity(): number {
    return this.lookSens;
  }

  /**
   * Hide the layer and make every input inert, or bring it back.
   *
   * Releasing on the way *in* is the point: a menu that appears while a thumb is holding the stick would
   * otherwise leave `strafe`/`forward` latched at whatever they were, and the player would still be
   * walking — into a wall, into the daayan — for as long as the menu stayed up. Coming back out, the
   * stick is already zeroed and the finger has to press again, which is what anyone expects after a
   * pause. Toggle buttons keep their state: crouching into a hiding place and pausing should not stand
   * the player up.
   */
  setPaused(on: boolean): void {
    if (this.paused === on) return;
    this.paused = on;
    if (on) {
      this.releaseJoystick();
      this.lookTouchId = null;
      this.lookDeltaX = 0;
      this.lookDeltaY = 0;
      this.keys.clear();
    }
    this.root.style.display = on ? 'none' : '';
  }

  getMove(): { strafe: number; forward: number; run: boolean; crouch: boolean } {
    // Paused reports a dead stick rather than relying on the overlay to have eaten the touches: the
    // keyboard listeners are on `document` and keep firing behind a menu, and a held WASD key would walk
    // the player through the pause.
    if (this.paused) return { strafe: 0, forward: 0, run: false, crouch: this.wantCrouch };
    // Desktop WASD supplements joystick.
    let strafe = this.strafe;
    let forward = this.forward;
    if (this.keys.has('w') || this.keys.has('arrowup')) forward = Math.max(forward, 1);
    if (this.keys.has('s') || this.keys.has('arrowdown')) forward = Math.min(forward, -1);
    if (this.keys.has('a') || this.keys.has('arrowleft')) strafe = Math.min(strafe, -1);
    if (this.keys.has('d') || this.keys.has('arrowright')) strafe = Math.max(strafe, 1);

    return { strafe, forward, run: this.wantRun, crouch: this.wantCrouch };
  }

  consumeLookDelta(): { yaw: number; pitch: number } {
    const d = { yaw: this.lookDeltaX, pitch: this.lookDeltaY };
    this.lookDeltaX = 0;
    this.lookDeltaY = 0;
    return d;
  }

  dispose(): void {
    this.root.remove();
    this.sheet.remove();
    document.removeEventListener('keydown', this.onKeyDown);
    document.removeEventListener('keyup', this.onKeyUp);
    document.removeEventListener('pointerlockchange', this.onPointerLockChange);
    document.removeEventListener('mousemove', this.onMouseMove);
    document.removeEventListener('touchend', this.onGlobalTouchEnd);
    document.removeEventListener('touchcancel', this.onGlobalTouchEnd);
    document.removeEventListener('visibilitychange', this.onVisibilityChange);
    window.removeEventListener('blur', this.onWindowBlur);
  }

  // -------- internals --------

  private makeJoystickBase(): HTMLDivElement {
    const el = document.createElement('div');
    const d = TouchControls.JOY_RADIUS * 2;
    el.style.cssText = `
      position: absolute; left: 0px; top: 0px;
      width: ${d}px; height: ${d}px; margin: ${-TouchControls.JOY_RADIUS}px 0 0 ${-TouchControls.JOY_RADIUS}px;
      border-radius: 50%; background: rgba(255,255,255,0.07); border: 2px solid rgba(255,255,255,0.22);
      pointer-events: none; touch-action: none; opacity: 0; transition: opacity 0.12s ease-out;
    `;
    return el;
  }

  private makeJoystickKnob(): HTMLDivElement {
    const el = document.createElement('div');
    el.style.cssText = `
      position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%);
      width: 52px; height: 52px; border-radius: 50%;
      background: rgba(255,255,255,0.38); border: 1px solid rgba(255,255,255,0.55);
      box-shadow: 0 0 10px rgba(0,0,0,0.5);
    `;
    return el;
  }

  /** Park the joystick at the given screen point and fade it in. */
  private showJoystickAt(x: number, y: number): void {
    this.joyOriginX = x;
    this.joyOriginY = y;
    this.joystickBase.style.left = `${x}px`;
    this.joystickBase.style.top = `${y}px`;
    this.joystickBase.style.opacity = '1';
    this.joystickKnob.style.transform = 'translate(-50%, -50%)';
  }

  private hideJoystick(): void {
    this.joystickBase.style.opacity = '0';
    this.joystickKnob.style.transform = 'translate(-50%, -50%)';
  }

  /** The top-left square that toggles the debug overlay, and therefore never starts a walk. */
  private inDebugCorner(x: number, y: number): boolean {
    return x < TouchControls.DEBUG_CORNER && y < TouchControls.DEBUG_CORNER;
  }

  private addButton(
    id: string,
    label: string,
    icon: string,
    pos: { right?: string; left?: string; top?: string; bottom?: string },
    onTap: () => void,
  ): HTMLButtonElement {
    const el = document.createElement('button');
    el.id = `tc-btn-${id}`;
    el.className = 'tc-btn';
    // `icon` is one of four constants defined a few lines above the call sites — the PAUSE one has to be
    // markup because it is two CSS bars rather than a glyph. Nothing here is ever player-supplied.
    el.innerHTML = `<span class="tc-ico">${icon}</span><span class="tc-lab">${label}</span>`;
    Object.assign(el.style, pos satisfies Partial<CSSStyleDeclaration>);
    // pointerdown only — it covers touch, mouse and pen, and responds on first contact
    // (no 300ms tap delay). Adding a `click` listener as well would double-fire on mouse
    // input and cancel out every toggle, so it is deliberately absent.
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (this.paused) return;
      // The press state is a class rather than :active, because :active on a touch target in Android
      // WebView sticks until the next tap elsewhere once the pointer is captured.
      el.classList.add('tc-press');
      onTap();
    });
    // Every way a press can end, including the finger sliding off onto the look surface behind — which
    // is common enough on this column that leaving it out means buttons that stay lit for good.
    const release = (): void => el.classList.remove('tc-press');
    el.addEventListener('pointerup', release);
    el.addEventListener('pointercancel', release);
    el.addEventListener('pointerleave', release);
    this.root.appendChild(el);
    this.buttons.push({ el, label });
    return el;
  }

  /** Update the visual state of toggle buttons (RUN, CROUCH) so the user sees what is on. */
  private refreshToggleStyles(): void {
    this.runBtn?.classList.toggle('tc-on', this.wantRun);
    this.crouchBtn?.classList.toggle('tc-on', this.wantCrouch);
  }

  private attachTouchHandlers(): void {
    // --- Move surface (left half): dynamic joystick ---
    this.moveSurface.addEventListener('touchstart', (e) => {
      const t = e.changedTouches[0];
      if (!t) return;
      // Leave the debug-overlay corner alone so tapping it does not also start a walk.
      if (this.inDebugCorner(t.clientX, t.clientY)) {
        e.preventDefault();
        this.onToggleDebug();
        return;
      }
      e.preventDefault();
      // An id still latched from a finger that is already gone would make the guard below reject
      // this touch and every one after it — the stick would be dead until the app was backgrounded.
      // Only `e.touches` knows what is really still down, so reconcile against it before guarding.
      // The watchdog at the end of this method is the other half of the same problem.
      if (this.joyTouchId !== null && !hasTouch(e.touches, this.joyTouchId)) this.releaseJoystick();
      // Ignore extra fingers. Overwriting joyTouchId with a second touch was the stick bug:
      // the new id gets tracked, the original finger keeps moving untracked, and when the
      // second finger lifts we clear the id while strafe/forward stay frozen at their last
      // value — so the player walks off in one direction with nothing left to steer them.
      if (this.joyTouchId !== null) return;
      this.joyTouchId = t.identifier;
      this.showJoystickAt(t.clientX, t.clientY);
    });
    this.moveSurface.addEventListener('touchmove', (e) => {
      e.preventDefault();
      for (const t of e.changedTouches) {
        if (t.identifier === this.joyTouchId) {
          this.updateJoystick(t.clientX, t.clientY);
          return;
        }
      }
      // Nothing we track moved, and the stick is not held: a finger is dragging on this surface
      // with no ring under it. Two ways that happens, and both were felt as the stick going dead
      // mid-play — a touchstart we never received (the WebView cancelled the sequence but kept the
      // finger down, or routed the start elsewhere), and a finger swap: two fingers on this half,
      // the tracked one lifts, and the survivor is untracked with nothing left to steer. Adopt it.
      // The ring spawns where the finger is *now* rather than where it went down, which is the only
      // origin that does not snap the stick straight to full deflection.
      if (this.joyTouchId !== null) return;
      const t = e.changedTouches[0];
      if (!t || this.inDebugCorner(t.clientX, t.clientY)) return;
      this.joyTouchId = t.identifier;
      this.showJoystickAt(t.clientX, t.clientY);
    });
    const endJoy = (e: TouchEvent): void => {
      for (const t of e.changedTouches) {
        if (t.identifier === this.joyTouchId) {
          this.releaseJoystick();
          break;
        }
      }
    };
    this.moveSurface.addEventListener('touchend', endJoy);
    this.moveSurface.addEventListener('touchcancel', endJoy);

    // --- Look surface (right half) ---
    this.lookSurface.addEventListener('touchstart', (e) => {
      const t = e.changedTouches[0];
      if (!t) return;
      // preventDefault stops the WebView starting a long-press/selection gesture, which on
      // Android swallows the following touchmove stream and freezes the camera mid-turn.
      e.preventDefault();
      if (this.lookTouchId !== null && !hasTouch(e.touches, this.lookTouchId)) this.lookTouchId = null;
      if (this.lookTouchId !== null) return;
      this.lookTouchId = t.identifier;
      this.lookLastX = t.clientX;
      this.lookLastY = t.clientY;
    });
    this.lookSurface.addEventListener('touchmove', (e) => {
      e.preventDefault();
      for (const t of e.changedTouches) {
        if (t.identifier === this.lookTouchId) {
          const dx = t.clientX - this.lookLastX;
          const dy = t.clientY - this.lookLastY;
          this.lookLastX = t.clientX;
          this.lookLastY = t.clientY;
          this.lookDeltaX += dx * this.lookSens;
          this.lookDeltaY += dy * this.lookSens;
          return;
        }
      }
      // Adopt an untracked drag, for the reasons given on the move surface. The swap case is more
      // common on this half, because the action buttons live here and a finger that slides off one
      // continues as a drag on the surface behind it. Seeding last-x/y from the current point is
      // what stops the camera snapping by the whole distance the finger has already travelled.
      if (this.lookTouchId !== null) return;
      const t = e.changedTouches[0];
      if (!t) return;
      this.lookTouchId = t.identifier;
      this.lookLastX = t.clientX;
      this.lookLastY = t.clientY;
    });
    const endLook = (e: TouchEvent): void => {
      for (const t of e.changedTouches) {
        if (t.identifier === this.lookTouchId) {
          this.lookTouchId = null;
          break;
        }
      }
    };
    this.lookSurface.addEventListener('touchend', endLook);
    this.lookSurface.addEventListener('touchcancel', endLook);

    // Watchdog. The per-surface handlers above only fire for touches the browser still routes
    // to that element, and a touch can disappear without one: an edge-swipe claimed by Android
    // gesture nav, a finger leaving the screen during a system overlay, a dropped event under
    // load. `e.touches` is the authoritative list of what is still down document-wide, so if a
    // tracked id is not in it, that finger is gone and we release regardless of who got the
    // event. This is the difference between "joystick sometimes sticks" and "never sticks".
    document.addEventListener('touchend', this.onGlobalTouchEnd, { passive: true });
    document.addEventListener('touchcancel', this.onGlobalTouchEnd, { passive: true });
    // Backgrounding the app mid-walk otherwise resumes with the stick still held.
    document.addEventListener('visibilitychange', this.onVisibilityChange);
    window.addEventListener('blur', this.onWindowBlur);
  }

  /** Drop the joystick touch and zero the movement intent. */
  private releaseJoystick(): void {
    this.joyTouchId = null;
    this.strafe = 0;
    this.forward = 0;
    this.hideJoystick();
  }

  private onGlobalTouchEnd = (e: TouchEvent): void => {
    if (this.joyTouchId !== null && !hasTouch(e.touches, this.joyTouchId)) this.releaseJoystick();
    if (this.lookTouchId !== null && !hasTouch(e.touches, this.lookTouchId)) this.lookTouchId = null;
  };

  private onVisibilityChange = (): void => {
    if (document.visibilityState !== 'visible') this.releaseAll();
  };

  private onWindowBlur = (): void => {
    this.releaseAll();
  };

  /** Release every held input. Called when the app loses focus or is backgrounded. */
  private releaseAll(): void {
    this.releaseJoystick();
    this.lookTouchId = null;
    this.keys.clear();
    if (this.wantRun) {
      this.wantRun = false;
      this.refreshToggleStyles();
    }
  }

  private updateJoystick(clientX: number, clientY: number): void {
    let dx = clientX - this.joyOriginX;
    let dy = clientY - this.joyOriginY;
    const dist = Math.hypot(dx, dy);
    if (dist > TouchControls.JOY_RADIUS) {
      dx = (dx / dist) * TouchControls.JOY_RADIUS;
      dy = (dy / dist) * TouchControls.JOY_RADIUS;
    }
    this.joystickKnob.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
    this.strafe = clampUnit(dx / TouchControls.JOY_RADIUS);
    this.forward = clampUnit(-dy / TouchControls.JOY_RADIUS);
  }

  private attachKeyboardHandlers(): void {
    this.onKeyDown = (e: KeyboardEvent) => {
      // Esc and P reach the pause handler whether or not the game is already paused — that is what makes
      // Esc close the menu again, and it is the one key that must not be gated on `paused` below.
      if (e.key === 'Escape' || e.key === 'p' || e.key === 'P') {
        this.onPause();
        return;
      }
      if (this.paused) return;
      this.keys.add(e.key.toLowerCase());
      if (e.key === '`' || e.key === '~') {
        this.onToggleDebug();
      }
      if (e.key === 'e' || e.key === 'E') {
        this.onInteract();
      }
      if (e.key === 'Shift') {
        if (!this.wantRun) {
          this.wantRun = true;
          this.refreshToggleStyles();
        }
      }
      if (e.key === 'c' || e.key === 'C') {
        this.wantCrouch = !this.wantCrouch;
        this.refreshToggleStyles();
      }
    };
    this.onKeyUp = (e: KeyboardEvent) => {
      this.keys.delete(e.key.toLowerCase());
      if (e.key === 'Shift') {
        this.wantRun = false;
        this.refreshToggleStyles();
      }
    };
    this.onPointerLockChange = () => {
      this.pointerLocked = document.pointerLockElement === this.root;
    };
    this.onMouseMove = (e: MouseEvent) => {
      if (!this.pointerLocked || this.paused) return;
      this.lookDeltaX += e.movementX * this.lookSens;
      this.lookDeltaY += e.movementY * this.lookSens;
    };
    document.addEventListener('keydown', this.onKeyDown);
    document.addEventListener('keyup', this.onKeyUp);
    document.addEventListener('pointerlockchange', this.onPointerLockChange);
    document.addEventListener('mousemove', this.onMouseMove);
    // Desktop: top-left corner click toggles the overlay, anywhere else grabs pointer lock.
    this.root.addEventListener('click', (e) => {
      if (this.inDebugCorner(e.clientX, e.clientY)) {
        this.onToggleDebug();
        return;
      }
      if (!this.pointerLocked) this.grabPointerLock();
    });
  }

  /**
   * Desktop-only. A touch device has no pointer to lock, and asking anyway is not harmless: on
   * Android WebView (Chrome 150) `requestPointerLock` returns a promise that rejects with
   * "UnknownError: If you see this error we have a bug. Please report this bug to chromium."
   * Nothing awaits it, so it surfaces as an unhandled rejection and paints the on-screen error
   * box over a game that is running fine. The `.catch` also covers desktop browsers that refuse
   * the lock for their own reasons (no user gesture, sandboxed frame).
   */
  private grabPointerLock(): void {
    if (navigator.maxTouchPoints > 0) return;
    const req = this.root.requestPointerLock?.() as unknown;
    if (req instanceof Promise) req.catch(() => {});
  }

  private onKeyDown = (_e: KeyboardEvent) => {};
  private onKeyUp = (_e: KeyboardEvent) => {};
  private onPointerLockChange = () => {};
  private onMouseMove = (_e: MouseEvent) => {};
}

function clampUnit(v: number): number {
  const abs = Math.abs(v);
  if (abs < TouchControls.MOVE_DEADZONE) return 0;
  return Math.sign(v) * (abs - TouchControls.MOVE_DEADZONE) / (1 - TouchControls.MOVE_DEADZONE);
}

/**
 * The action buttons' stylesheet, injected once.
 *
 * Why a stylesheet and not the inline styles this used to carry: the press and toggle states are class
 * swaps, and a class swap re-resolves one selector where the old code assigned three inline properties
 * per state change. It is also the only way to style the icon and label *inside* the button without
 * building two more elements' style strings by hand.
 *
 * What is deliberately absent is `backdrop-filter: blur()`. It looks exactly right on a dark game and it
 * costs a framebuffer readback per composited frame, on the one surface stacked over a canvas we are
 * already short of frames on — the lag report is the reason it is not here. The glass look is faked with
 * a static radial gradient and an inset highlight instead, which is free after the first paint.
 *
 * Only `transform` and `filter` are transitioned, both composited. Transitioning `background` or
 * `box-shadow` would repaint the button every frame of the 90 ms press.
 */
function injectButtonStyles(): HTMLStyleElement {
  const el = document.createElement('style');
  el.id = 'tc-styles';
  el.textContent = `
    .tc-btn {
      position: absolute; width: 68px; height: 68px; border-radius: 50%;
      display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 3px;
      -webkit-appearance: none; appearance: none; padding: 0; margin: 0;
      pointer-events: auto; touch-action: none; cursor: pointer;
      -webkit-tap-highlight-color: transparent;
      color: #efe3cf;
      background:
        radial-gradient(circle at 50% 30%, rgba(74,66,58,0.80) 0%, rgba(30,25,26,0.86) 58%, rgba(9,7,9,0.90) 100%);
      border: 1.5px solid rgba(255,206,150,0.30);
      box-shadow:
        0 3px 12px rgba(0,0,0,0.62),
        inset 0 1px 0 rgba(255,236,208,0.16),
        inset 0 -6px 12px rgba(0,0,0,0.42);
      transition: transform 90ms ease-out, filter 90ms ease-out;
      will-change: transform;
    }
    .tc-btn.tc-small { width: 48px; height: 48px; gap: 2px; }
    .tc-ico {
      font: 400 17px/1 system-ui, sans-serif; opacity: 0.92;
      text-shadow: 0 1px 3px rgba(0,0,0,0.85);
      display: flex; align-items: center; justify-content: center; height: 17px;
    }
    .tc-small .tc-ico { font-size: 0; height: 14px; }
    .tc-lab {
      font: 600 9px/1 ui-monospace, monospace; letter-spacing: 0.09em;
      opacity: 0.86; text-shadow: 0 1px 2px rgba(0,0,0,0.9);
    }
    .tc-small .tc-lab { font-size: 8px; letter-spacing: 0.06em; }
    /* PAUSE's two bars — see the call site for why this is not a glyph. */
    .tc-bar {
      display: inline-block; width: 3.5px; height: 13px; margin: 0 2px;
      background: currentColor; border-radius: 1px;
    }
    .tc-btn.tc-press { transform: scale(0.92); filter: brightness(1.35); }
    .tc-btn.tc-on {
      color: #2b1602;
      background:
        radial-gradient(circle at 50% 28%, #ffd79b 0%, #f0a544 55%, #c9761d 100%);
      border-color: rgba(255,240,214,0.85);
      box-shadow:
        0 0 16px rgba(255,168,64,0.45),
        0 3px 12px rgba(0,0,0,0.5),
        inset 0 1px 0 rgba(255,255,255,0.5);
    }
    .tc-btn.tc-on .tc-ico, .tc-btn.tc-on .tc-lab {
      opacity: 1; text-shadow: 0 1px 1px rgba(255,255,255,0.35);
    }
  `;
  document.head.appendChild(el);
  return el;
}

/** Is `id` still among the touches currently down? TouchList has no .find(). */
function hasTouch(list: TouchList, id: number): boolean {
  for (let i = 0; i < list.length; i++) {
    if (list[i]?.identifier === id) return true;
  }
  return false;
}
