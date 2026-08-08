import * as CANNON from 'cannon-es';
import type { MapDef } from '../data/schema';
import { WORLD_MASK, type PhysicsWorld } from '../physics/world';

const CELL = 3;
const MAX_STEP = 1.6;
const UNREACHABLE = 1e9;

/**
 * Navigation grid sampled straight out of the physics world: one downward ray
 * per cell gives the drivable surface height, and neighbours connect only when
 * the step between them is small enough for a tank to climb. That handles
 * ramps, bridges and raised platforms without authoring a separate navmesh,
 * and it stays correct if a map's props change.
 */
export class NavGrid {
  readonly cols: number;
  readonly rows: number;
  readonly originX: number;
  readonly originZ: number;
  private readonly height: Float32Array;
  private readonly blocked: Uint8Array;
  private readonly clearance: Float32Array;
  /**
   * Extra pathing cost for ground that has been churned up — crater fields and
   * the spill around a collapsed building. Nothing is made impassable by it: a
   * bot will still cross a crater to reach something worth reaching, it just
   * stops treating a shelled street as if it were a road.
   */
  private readonly rough: Float32Array;

  // Scratch buffers reused by every search — pathfinding must not allocate.
  private readonly gScore: Float32Array;
  private readonly fScore: Float32Array;
  private readonly cameFrom: Int32Array;
  private readonly closed: Uint8Array;
  private readonly openHeap: number[] = [];
  private stamp = 0;
  private readonly visited: Int32Array;

  constructor(phys: PhysicsWorld, def: MapDef) {
    this.originX = -def.bounds.x - CELL;
    this.originZ = -def.bounds.z - CELL;
    this.cols = Math.ceil(((def.bounds.x + CELL) * 2) / CELL);
    this.rows = Math.ceil(((def.bounds.z + CELL) * 2) / CELL);

    const n = this.cols * this.rows;
    this.height = new Float32Array(n);
    this.blocked = new Uint8Array(n);
    this.clearance = new Float32Array(n);
    this.rough = new Float32Array(n);
    this.gScore = new Float32Array(n);
    this.fScore = new Float32Array(n);
    this.cameFrom = new Int32Array(n);
    this.closed = new Uint8Array(n);
    this.visited = new Int32Array(n);

    this.sample(phys);
    this.computeClearance();
  }

  private sample(phys: PhysicsWorld): void {
    this.sampleRegion(phys, 0, 0, this.cols - 1, this.rows - 1);
  }

  private sampleRegion(phys: PhysicsWorld, i0: number, j0: number, i1: number, j1: number): void {
    const from = new CANNON.Vec3();
    const to = new CANNON.Vec3();
    for (let j = Math.max(0, j0); j <= Math.min(this.rows - 1, j1); j++) {
      for (let i = Math.max(0, i0); i <= Math.min(this.cols - 1, i1); i++) {
        const idx = j * this.cols + i;
        const x = this.originX + (i + 0.5) * CELL;
        const z = this.originZ + (j + 0.5) * CELL;
        from.set(x, 300, z);
        to.set(x, -5, z);
        const hit = phys.raycast(from, to, WORLD_MASK);
        if (!hit) {
          this.blocked[idx] = 1;
          this.height[idx] = 0;
          continue;
        }
        this.height[idx] = hit.point.y;
        // Steep faces are not drivable surfaces.
        this.blocked[idx] = hit.normal.y < 0.55 ? 1 : 0;
      }
    }
  }

  /**
   * Re-sample a rectangle of the grid after the map itself has changed — a
   * building toppled into rubble, an elevated deck shot away.
   *
   * The whole navgrid is sampled out of the physics world in the first place,
   * so keeping it honest after a demolition is the same operation over a small
   * window rather than a separate authoring step. Clearance is recomputed one
   * ring wider than the resampled patch, since a cell's clearance is a function
   * of its neighbours.
   */
  resample(phys: PhysicsWorld, minX: number, minZ: number, maxX: number, maxZ: number): void {
    const i0 = Math.floor((minX - this.originX) / CELL) - 1;
    const j0 = Math.floor((minZ - this.originZ) / CELL) - 1;
    const i1 = Math.floor((maxX - this.originX) / CELL) + 1;
    const j1 = Math.floor((maxZ - this.originZ) / CELL) + 1;
    this.sampleRegion(phys, i0, j0, i1, j1);
    this.computeClearance(i0 - 1, j0 - 1, i1 + 1, j1 + 1);
  }

  /** Marks ground as churned up, so paths prefer to go round it. */
  roughen(x: number, z: number, radius: number, amount: number): void {
    const i0 = Math.floor((x - radius - this.originX) / CELL);
    const j0 = Math.floor((z - radius - this.originZ) / CELL);
    const i1 = Math.floor((x + radius - this.originX) / CELL);
    const j1 = Math.floor((z + radius - this.originZ) / CELL);
    for (let j = Math.max(0, j0); j <= Math.min(this.rows - 1, j1); j++) {
      for (let i = Math.max(0, i0); i <= Math.min(this.cols - 1, i1); i++) {
        const cx = this.originX + (i + 0.5) * CELL;
        const cz = this.originZ + (j + 0.5) * CELL;
        if (Math.hypot(cx - x, cz - z) > radius) continue;
        const idx = j * this.cols + i;
        this.rough[idx] = Math.min(6, this.rough[idx] + amount);
      }
    }
  }

  /**
   * Distance-to-obstacle field. Bots pay a cost for hugging walls, which keeps
   * a 5 m-wide hull off corners without inflating obstacles into dead ends.
   */
  private computeClearance(i0 = 0, j0 = 0, i1 = this.cols - 1, j1 = this.rows - 1): void {
    for (let j = Math.max(0, j0); j <= Math.min(this.rows - 1, j1); j++) {
      for (let i = Math.max(0, i0); i <= Math.min(this.cols - 1, i1); i++) {
        const idx = j * this.cols + i;
        if (this.blocked[idx]) {
          this.clearance[idx] = 0;
          continue;
        }
        let worst = 3;
        for (let dj = -1; dj <= 1; dj++) {
          for (let di = -1; di <= 1; di++) {
            if (!di && !dj) continue;
            const ni = i + di;
            const nj = j + dj;
            if (ni < 0 || nj < 0 || ni >= this.cols || nj >= this.rows) {
              worst = 0;
              continue;
            }
            const nIdx = nj * this.cols + ni;
            if (this.blocked[nIdx] || Math.abs(this.height[nIdx] - this.height[idx]) > MAX_STEP) worst = 0;
          }
        }
        this.clearance[idx] = worst;
      }
    }
  }

  index(x: number, z: number): number {
    const i = Math.floor((x - this.originX) / CELL);
    const j = Math.floor((z - this.originZ) / CELL);
    if (i < 0 || j < 0 || i >= this.cols || j >= this.rows) return -1;
    return j * this.cols + i;
  }

  cellCentre(idx: number, out = new CANNON.Vec3()): CANNON.Vec3 {
    const i = idx % this.cols;
    const j = Math.floor(idx / this.cols);
    out.set(this.originX + (i + 0.5) * CELL, this.height[idx], this.originZ + (j + 0.5) * CELL);
    return out;
  }

  isWalkable(idx: number): boolean {
    return idx >= 0 && !this.blocked[idx];
  }

  surfaceHeight(x: number, z: number): number {
    const idx = this.index(x, z);
    return idx < 0 ? 0 : this.height[idx];
  }

  /** Nearest walkable cell to a world point, searched outward in rings. */
  nearestWalkable(x: number, z: number, maxRings = 6): number {
    const i0 = Math.floor((x - this.originX) / CELL);
    const j0 = Math.floor((z - this.originZ) / CELL);
    for (let r = 0; r <= maxRings; r++) {
      for (let dj = -r; dj <= r; dj++) {
        for (let di = -r; di <= r; di++) {
          if (r > 0 && Math.abs(di) !== r && Math.abs(dj) !== r) continue;
          const i = i0 + di;
          const j = j0 + dj;
          if (i < 0 || j < 0 || i >= this.cols || j >= this.rows) continue;
          const idx = j * this.cols + i;
          if (!this.blocked[idx]) return idx;
        }
      }
    }
    return -1;
  }

  /**
   * A* over the sampled grid. Returns world-space waypoints, already
   * string-pulled so a bot on open ground drives straight instead of stepping
   * through every cell centre.
   */
  findPath(fromX: number, fromZ: number, toX: number, toZ: number, budget = 6000): CANNON.Vec3[] {
    const start = this.nearestWalkable(fromX, fromZ);
    const goal = this.nearestWalkable(toX, toZ);
    if (start < 0 || goal < 0) return [];
    if (start === goal) return [this.cellCentre(goal)];

    this.stamp += 1;
    const stamp = this.stamp;
    this.openHeap.length = 0;

    this.gScore[start] = 0;
    this.fScore[start] = this.heuristic(start, goal);
    this.cameFrom[start] = -1;
    this.closed[start] = 0;
    this.visited[start] = stamp;
    this.heapPush(start);

    let expanded = 0;
    let best = start;
    let bestH = this.heuristic(start, goal);

    while (this.openHeap.length && expanded++ < budget) {
      const current = this.heapPop();
      if (current === goal) return this.reconstruct(current);
      this.closed[current] = 1;

      const h = this.heuristic(current, goal);
      if (h < bestH) {
        bestH = h;
        best = current;
      }

      const ci = current % this.cols;
      const cj = Math.floor(current / this.cols);
      for (let dj = -1; dj <= 1; dj++) {
        for (let di = -1; di <= 1; di++) {
          if (!di && !dj) continue;
          const ni = ci + di;
          const nj = cj + dj;
          if (ni < 0 || nj < 0 || ni >= this.cols || nj >= this.rows) continue;
          const n = nj * this.cols + ni;
          if (this.blocked[n]) continue;
          if (this.visited[n] === stamp && this.closed[n]) continue;

          const climb = Math.abs(this.height[n] - this.height[current]);
          if (climb > MAX_STEP) continue;
          // Diagonals must not cut a corner through a blocked cell.
          if (di && dj) {
            const a = cj * this.cols + ni;
            const b = nj * this.cols + ci;
            if (this.blocked[a] || this.blocked[b]) continue;
          }

          const step = (di && dj ? 1.4142 : 1) * CELL;
          const penalty = (3 - this.clearance[n]) * 1.4 + climb * 1.5 + this.rough[n];
          const tentative = (this.visited[current] === stamp ? this.gScore[current] : 0) + step + penalty;

          if (this.visited[n] !== stamp) {
            this.visited[n] = stamp;
            this.closed[n] = 0;
            this.gScore[n] = UNREACHABLE;
          }
          if (tentative >= this.gScore[n]) continue;
          this.cameFrom[n] = current;
          this.gScore[n] = tentative;
          this.fScore[n] = tentative + this.heuristic(n, goal);
          this.heapPush(n);
        }
      }
    }
    return this.reconstruct(best);
  }

  private reconstruct(end: number): CANNON.Vec3[] {
    const cells: number[] = [];
    let c = end;
    let guard = 0;
    while (c >= 0 && guard++ < 4000) {
      cells.push(c);
      c = this.cameFrom[c];
    }
    cells.reverse();
    return this.stringPull(cells);
  }

  /** Drops waypoints that are collinear-ish and at the same height. */
  private stringPull(cells: number[]): CANNON.Vec3[] {
    if (cells.length <= 2) return cells.map((c) => this.cellCentre(c));
    const out: CANNON.Vec3[] = [this.cellCentre(cells[0])];
    for (let i = 1; i < cells.length - 1; i++) {
      const prev = out[out.length - 1];
      const cur = this.cellCentre(cells[i]);
      const next = this.cellCentre(cells[i + 1]);
      const d1x = cur.x - prev.x;
      const d1z = cur.z - prev.z;
      const d2x = next.x - cur.x;
      const d2z = next.z - cur.z;
      const cross = d1x * d2z - d1z * d2x;
      const heightChange = Math.abs(next.y - prev.y) > 0.6;
      if (Math.abs(cross) > 0.5 || heightChange) out.push(cur);
    }
    out.push(this.cellCentre(cells[cells.length - 1]));
    return out;
  }

  private heuristic(a: number, b: number): number {
    const ax = a % this.cols;
    const az = Math.floor(a / this.cols);
    const bx = b % this.cols;
    const bz = Math.floor(b / this.cols);
    const dx = Math.abs(ax - bx);
    const dz = Math.abs(az - bz);
    return (Math.max(dx, dz) + 0.414 * Math.min(dx, dz)) * CELL;
  }

  // ---- binary heap keyed on fScore -------------------------------------

  private heapPush(idx: number): void {
    const heap = this.openHeap;
    heap.push(idx);
    let i = heap.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.fScore[heap[parent]] <= this.fScore[heap[i]]) break;
      [heap[parent], heap[i]] = [heap[i], heap[parent]];
      i = parent;
    }
  }

  private heapPop(): number {
    const heap = this.openHeap;
    const top = heap[0];
    const last = heap.pop()!;
    if (heap.length) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let smallest = i;
        if (l < heap.length && this.fScore[heap[l]] < this.fScore[heap[smallest]]) smallest = l;
        if (r < heap.length && this.fScore[heap[r]] < this.fScore[heap[smallest]]) smallest = r;
        if (smallest === i) break;
        [heap[smallest], heap[i]] = [heap[i], heap[smallest]];
        i = smallest;
      }
    }
    return top;
  }
}
