export interface InputState {
  forward: number;
  turn: number;
  /** Turret slew request, -1 left … 1 right. Rate is applied by the battle. */
  turretTurn: number;
  /** Snap the turret back to the hull's forward direction. Edge triggered. */
  centreTurret: boolean;
  fire: boolean;
  overdrive: boolean;
  flip: boolean;
  supply: number | null;
  /** Continuous camera boom request, -1 in … 1 out. */
  zoom: number;
}

/**
 * Keyboard-only controls. There is no pointer capture and no mouse state at
 * all: the arrow keys drive, Z/X slew the turret, Space fires, and elevation is
 * resolved by the auto-aim in `Battle`. Everything the player can do in a
 * battle is reachable from the keyboard.
 */
export class Input {
  readonly keys = new Set<string>();
  readonly state: InputState = {
    forward: 0,
    turn: 0,
    turretTurn: 0,
    centreTurret: false,
    fire: false,
    overdrive: false,
    flip: false,
    supply: null,
    zoom: 0,
  };

  private pendingSupply: number | null = null;
  private pendingFlip = false;
  private pendingCentre = false;
  private enabled = true;

  constructor(opts: { onEscape?: () => void } = {}) {
    window.addEventListener('keydown', (e) => {
      if (e.code === 'Escape') {
        opts.onEscape?.();
        return;
      }
      if (!this.enabled) return;
      if (PREVENT_DEFAULT.has(e.code)) e.preventDefault();
      if (e.repeat) return;
      this.keys.add(e.code);
      if (e.code.startsWith('Digit')) {
        const n = Number(e.code.slice(5));
        if (n >= 1 && n <= 5) this.pendingSupply = n;
      }
      if (e.code === 'KeyR') this.pendingFlip = true;
      if (e.code === 'KeyC') this.pendingCentre = true;
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    if (!on) {
      this.keys.clear();
      this.state.fire = false;
      this.pendingSupply = null;
      this.pendingFlip = false;
      this.pendingCentre = false;
    }
  }

  /** Snapshot for this frame; consumes edge-triggered values. */
  sample(): InputState {
    const k = this.keys;
    const s = this.state;
    const axis = (pos: string[], neg: string[]) =>
      (pos.some((c) => k.has(c)) ? 1 : 0) - (neg.some((c) => k.has(c)) ? 1 : 0);

    s.forward = axis(['ArrowUp', 'KeyW'], ['ArrowDown', 'KeyS']);
    s.turn = axis(['ArrowRight', 'KeyD'], ['ArrowLeft', 'KeyA']);
    s.turretTurn = axis(['KeyX'], ['KeyZ']);
    s.zoom = axis(['Minus', 'NumpadSubtract'], ['Equal', 'NumpadAdd']);
    s.fire = k.has('Space');
    s.overdrive = k.has('KeyQ');
    s.centreTurret = this.pendingCentre;
    s.flip = this.pendingFlip;
    s.supply = this.pendingSupply;
    this.pendingCentre = false;
    this.pendingFlip = false;
    this.pendingSupply = null;
    return s;
  }
}

/** Keys the browser would otherwise scroll, tab or zoom with. */
const PREVENT_DEFAULT = new Set([
  'Space',
  'Tab',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'KeyR',
  'Minus',
  'Equal',
]);
