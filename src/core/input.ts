export interface InputState {
  forward: number;
  turn: number;
  fire: boolean;
  altFire: boolean;
  scope: boolean;
  overdrive: boolean;
  flip: boolean;
  /** Accumulated mouse delta since the last read, in radians of aim travel. */
  yawDelta: number;
  pitchDelta: number;
  supply: number | null;
  zoom: number;
}

const AIM_SENSITIVITY = 0.0022;

export class Input {
  readonly keys = new Set<string>();
  readonly state: InputState = {
    forward: 0,
    turn: 0,
    fire: false,
    altFire: false,
    scope: false,
    overdrive: false,
    flip: false,
    yawDelta: 0,
    pitchDelta: 0,
    supply: null,
    zoom: 0,
  };

  private pointerLocked = false;
  private pendingSupply: number | null = null;
  private pendingFlip = false;
  private enabled = true;
  private readonly onPointerLockRequest: () => void;

  constructor(
    private readonly el: HTMLElement,
    opts: { onEscape?: () => void } = {},
  ) {
    this.onPointerLockRequest = () => {
      if (this.enabled && !this.pointerLocked) void this.el.requestPointerLock?.();
    };

    el.addEventListener('mousedown', (e) => {
      if (!this.enabled) return;
      if (!this.pointerLocked) {
        this.onPointerLockRequest();
        return;
      }
      if (e.button === 0) this.state.fire = true;
      if (e.button === 2) this.state.altFire = true;
    });
    window.addEventListener('mouseup', (e) => {
      if (e.button === 0) this.state.fire = false;
      if (e.button === 2) this.state.altFire = false;
    });
    el.addEventListener('contextmenu', (e) => e.preventDefault());

    window.addEventListener('mousemove', (e) => {
      if (!this.pointerLocked || !this.enabled) return;
      this.state.yawDelta += e.movementX * AIM_SENSITIVITY;
      this.state.pitchDelta -= e.movementY * AIM_SENSITIVITY;
    });

    window.addEventListener(
      'wheel',
      (e) => {
        if (!this.enabled) return;
        this.state.zoom += Math.sign(e.deltaY);
      },
      { passive: true },
    );

    document.addEventListener('pointerlockchange', () => {
      this.pointerLocked = document.pointerLockElement === el;
      if (!this.pointerLocked) {
        this.state.fire = false;
        this.state.altFire = false;
        this.keys.clear();
      }
    });

    window.addEventListener('keydown', (e) => {
      if (e.code === 'Escape') {
        opts.onEscape?.();
        return;
      }
      if (!this.enabled) return;
      if (e.repeat) {
        e.preventDefault();
        return;
      }
      this.keys.add(e.code);
      if (e.code.startsWith('Digit')) {
        const n = Number(e.code.slice(5));
        if (n >= 1 && n <= 5) this.pendingSupply = n;
      }
      if (e.code === 'KeyR') this.pendingFlip = true;
      if (['Space', 'Tab', 'KeyR'].includes(e.code)) e.preventDefault();
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
  }

  get locked(): boolean {
    return this.pointerLocked;
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    if (!on) {
      this.keys.clear();
      this.state.fire = false;
      this.state.altFire = false;
      if (this.pointerLocked) document.exitPointerLock?.();
    }
  }

  requestLock(): void {
    this.onPointerLockRequest();
  }

  /** Snapshot for this frame; consumes edge-triggered values. */
  sample(): InputState {
    const k = this.keys;
    const s = this.state;
    s.forward = (k.has('KeyW') || k.has('ArrowUp') ? 1 : 0) - (k.has('KeyS') || k.has('ArrowDown') ? 1 : 0);
    s.turn = (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0) - (k.has('KeyA') || k.has('ArrowLeft') ? 1 : 0);
    s.scope = k.has('ShiftLeft') || k.has('ShiftRight');
    s.overdrive = k.has('Space');
    s.flip = this.pendingFlip;
    s.supply = this.pendingSupply;
    this.pendingFlip = false;
    this.pendingSupply = null;
    return s;
  }

  /** Clears per-frame accumulators after the sim has consumed them. */
  endFrame(): void {
    this.state.yawDelta = 0;
    this.state.pitchDelta = 0;
    this.state.zoom = 0;
  }
}
