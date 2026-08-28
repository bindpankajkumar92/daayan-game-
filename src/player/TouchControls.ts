/**
 * TouchControls — virtual joystick (left) + look-drag (right) + action buttons.
 * - Joystick: 100px ring, 50px knob; touch within the ring area.
 * - Look: drag anywhere on the right half of the screen; sensitivity 0.0035 rad/px.
 * - Action buttons: Run (toggle), Crouch (toggle), Interact (one-shot), Lantern (toggle).
 *
 * Desktop: WASD + pointer-lock mouse on the canvas. Esc releases.
 *
 * Emits a movement intent {strafe, forward, run, crouch} each frame via getMove().
 * Look deltas accumulate in a buffer; consume via consumeLookDelta().
 */

import type { FPController } from './FPController';
import type { DebugOverlay } from '@/core/DebugOverlay';

interface Button {
  el: HTMLButtonElement;
  label: string;
}

export class TouchControls {
  private root: HTMLDivElement;
  private joystickBase: HTMLDivElement;
  private joystickKnob: HTMLDivElement;
  private buttons: Button[] = [];

  private joyTouchId: number | null = null;
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
  private onToggleLantern: () => void = () => {};
  private onToggleDebug: () => void = () => {};

  // Desktop state
  private keys = new Set<string>();
  private pointerLocked = false;
  private tripleTapTimer = 0;
  private tripleTapCount = 0;

  private static readonly JOY_RADIUS = 50;
  private static readonly LOOK_SENSITIVITY = 0.0035;
  static readonly MOVE_DEADZONE = 0.12;

  // Reserved for future use (controller for movement, debug for overlay triggers).
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  constructor(_controller: FPController, _debug: DebugOverlay) {
    this.root = document.createElement('div');
    this.root.id = 'touch-controls';
    this.root.style.cssText = `
      position: fixed; inset: 0; pointer-events: none; z-index: 8000;
      user-select: none; -webkit-user-select: none; touch-action: none;
    `;
    document.body.appendChild(this.root);

    this.joystickBase = this.makeJoystickBase();
    this.joystickKnob = this.makeJoystickKnob();
    this.joystickBase.appendChild(this.joystickKnob);
    this.root.appendChild(this.joystickBase);

    // Right-half look surface — invisible, captures drag.
    const lookSurface = document.createElement('div');
    lookSurface.style.cssText = `
      position: absolute; right: 0; top: 0; width: 50%; height: 100%;
      pointer-events: auto;
    `;
    this.root.appendChild(lookSurface);

    // Action buttons — Interact (top-right), Run, Crouch, Lantern (bottom-right column).
    this.addButton('interact', 'INTERACT', { right: '12px', top: '12px' }, () => this.onInteract());
    this.addButton('run', 'RUN', { right: '12px', bottom: '80px' }, () => {
      this.wantRun = !this.wantRun;
    });
    this.addButton('crouch', 'CROUCH', { right: '12px', bottom: '140px' }, () => {
      this.wantCrouch = !this.wantCrouch;
    });
    this.addButton('lantern', 'LANTERN', { right: '12px', bottom: '20px' }, () => this.onToggleLantern());

    this.attachTouchHandlers();
    this.attachKeyboardHandlers();
  }

  setOnInteract(fn: () => void): void {
    this.onInteract = fn;
  }
  setOnToggleLantern(fn: () => void): void {
    this.onToggleLantern = fn;
  }
  setOnToggleDebug(fn: () => void): void {
    this.onToggleDebug = fn;
  }

  getMove(): { strafe: number; forward: number; run: boolean; crouch: boolean } {
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
    document.removeEventListener('keydown', this.onKeyDown);
    document.removeEventListener('keyup', this.onKeyUp);
    document.removeEventListener('pointerlockchange', this.onPointerLockChange);
    document.removeEventListener('mousemove', this.onMouseMove);
  }

  // -------- internals --------

  private makeJoystickBase(): HTMLDivElement {
    const el = document.createElement('div');
    el.style.cssText = `
      position: absolute; left: 24px; bottom: 24px;
      width: ${TouchControls.JOY_RADIUS * 2}px; height: ${TouchControls.JOY_RADIUS * 2}px;
      border-radius: 50%; background: rgba(255,255,255,0.10); border: 2px solid rgba(255,255,255,0.30);
      pointer-events: auto; touch-action: none;
    `;
    return el;
  }

  private makeJoystickKnob(): HTMLDivElement {
    const el = document.createElement('div');
    el.style.cssText = `
      position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%);
      width: 50px; height: 50px; border-radius: 50%;
      background: rgba(255,255,255,0.45); border: 1px solid rgba(255,255,255,0.6);
    `;
    return el;
  }

  private addButton(
    id: string,
    label: string,
    pos: { right?: string; left?: string; top?: string; bottom?: string },
    onTap: () => void,
  ): void {
    const el = document.createElement('button');
    el.id = `tc-btn-${id}`;
    el.textContent = label;
    Object.assign(el.style, {
      position: 'absolute',
      width: '64px',
      height: '64px',
      borderRadius: '50%',
      background: 'rgba(0,0,0,0.55)',
      color: '#ddd',
      border: '2px solid rgba(255,255,255,0.35)',
      font: 'bold 11px/1 ui-monospace, monospace',
      letterSpacing: '0.05em',
      pointerEvents: 'auto',
      touchAction: 'none',
      ...pos,
    } satisfies Partial<CSSStyleDeclaration>);
    el.addEventListener('click', (e: MouseEvent) => {
      e.preventDefault();
      onTap();
    });
    this.root.appendChild(el);
    this.buttons.push({ el, label });
  }

  private attachTouchHandlers(): void {
    // Joystick
    this.joystickBase.addEventListener('touchstart', (e) => {
      e.preventDefault();
      const t = e.changedTouches[0];
      if (!t) return;
      this.joyTouchId = t.identifier;
      this.updateJoystick(t);
    });
    this.joystickBase.addEventListener('touchmove', (e) => {
      e.preventDefault();
      for (const t of e.changedTouches) {
        if (t.identifier === this.joyTouchId) {
          this.updateJoystick(t);
          break;
        }
      }
    });
    const endJoy = (e: TouchEvent) => {
      for (const t of e.changedTouches) {
        if (t.identifier === this.joyTouchId) {
          this.joyTouchId = null;
          this.strafe = 0;
          this.forward = 0;
          this.joystickKnob.style.transform = 'translate(-50%, -50%)';
          break;
        }
      }
    };
    this.joystickBase.addEventListener('touchend', endJoy);
    this.joystickBase.addEventListener('touchcancel', endJoy);

    // Look surface — capture right-half touches for look.
    const lookSurface = this.root.children[1] as HTMLDivElement; // second child after joystick base
    lookSurface.addEventListener('touchstart', (e) => {
      const t = e.changedTouches[0];
      if (!t) return;
      this.lookTouchId = t.identifier;
      this.lookLastX = t.clientX;
      this.lookLastY = t.clientY;
    });
    lookSurface.addEventListener('touchmove', (e) => {
      e.preventDefault();
      for (const t of e.changedTouches) {
        if (t.identifier === this.lookTouchId) {
          const dx = t.clientX - this.lookLastX;
          const dy = t.clientY - this.lookLastY;
          this.lookLastX = t.clientX;
          this.lookLastY = t.clientY;
          this.lookDeltaX += dx * TouchControls.LOOK_SENSITIVITY;
          this.lookDeltaY += dy * TouchControls.LOOK_SENSITIVITY;
          break;
        }
      }
    });
    const endLook = (e: TouchEvent) => {
      for (const t of e.changedTouches) {
        if (t.identifier === this.lookTouchId) {
          this.lookTouchId = null;
          break;
        }
      }
    };
    lookSurface.addEventListener('touchend', endLook);
    lookSurface.addEventListener('touchcancel', endLook);

    // Triple-tap top-left corner to toggle debug overlay (mobile-friendly).
    this.root.addEventListener('touchstart', (e) => {
      const t = e.changedTouches[0];
      if (!t) return;
      // Only count taps near top-left, away from the joystick.
      if (t.clientX < 80 && t.clientY < 80) {
        const now = performance.now();
        if (now - this.tripleTapTimer < 500) this.tripleTapCount++;
        else this.tripleTapCount = 1;
        this.tripleTapTimer = now;
        if (this.tripleTapCount >= 3) {
          this.tripleTapCount = 0;
          this.onToggleDebug();
        }
      }
    });
  }

  private updateJoystick(t: Touch): void {
    const rect = this.joystickBase.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    let dx = t.clientX - cx;
    let dy = t.clientY - cy;
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
      this.keys.add(e.key.toLowerCase());
      if (e.key === '`' || e.key === '~') {
        this.onToggleDebug();
      }
      if (e.key === 'e' || e.key === 'E') {
        this.onInteract();
      }
      if (e.key === 'Shift') {
        this.wantRun = true;
      }
      if (e.key === 'c' || e.key === 'C') {
        this.wantCrouch = !this.wantCrouch;
      }
      if (e.key === 'f' || e.key === 'F') {
        this.onToggleLantern();
      }
    };
    this.onKeyUp = (e: KeyboardEvent) => {
      this.keys.delete(e.key.toLowerCase());
      if (e.key === 'Shift') this.wantRun = false;
    };
    this.onPointerLockChange = () => {
      this.pointerLocked = document.pointerLockElement === this.root;
    };
    this.onMouseMove = (e: MouseEvent) => {
      if (!this.pointerLocked) return;
      this.lookDeltaX += e.movementX * TouchControls.LOOK_SENSITIVITY;
      this.lookDeltaY += e.movementY * TouchControls.LOOK_SENSITIVITY;
    };
    document.addEventListener('keydown', this.onKeyDown);
    document.addEventListener('keyup', this.onKeyUp);
    document.addEventListener('pointerlockchange', this.onPointerLockChange);
    document.addEventListener('mousemove', this.onMouseMove);
    this.root.addEventListener('click', () => {
      if (!this.pointerLocked) this.root.requestPointerLock?.();
    });
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
