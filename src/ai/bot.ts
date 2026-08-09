import * as CANNON from 'cannon-es';
import { angleDelta, clamp, DEG, predictIntercept, randRange } from '../core/mathx';
import { preferredRange } from '../data';
import type { SupplyKind } from '../data/schema';
import type { DifficultyProfile } from '../data/difficulty';
import { WORLD_MASK } from '../physics/world';
import type { Arena } from '../game/types';
import type { Tank } from '../entities/tank';
import { action, condition, guard, selector, type Node, type Status } from './behaviour';
import type { AiController } from './controller';
import { NavGrid } from './navgrid';
import { Perception, type Track } from './perception';
import type { Persona } from './personas';
import { SquadChannel, SQUAD_LINES, type DangerZone, type Escape } from './squad';
import type { TeamBoard } from './teamboard';
import { EVACUATE_GIVE_UP, EVACUATE_MARGIN, RESCUE_REACH } from '../data/raid';

const TICK = 0.1;

export interface BotDeps {
  arena: Arena;
  nav: NavGrid;
  board: TeamBoard;
  profile: DifficultyProfile;
  /** Live handicap multiplier from the dynamic-difficulty controller. */
  slack: () => number;
  /** Nearest contestable pickup, or null. Provided by the battle. */
  nearestPickup: (from: CANNON.Vec3) => { pos: CANNON.Vec3; value: number } | null;
  /** Mode-supplied goal, e.g. the enemy flag or the weakest control point. */
  objective: (bot: Tank) => { pos: CANNON.Vec3; kind: 'attack' | 'defend'; weight: number } | null;
  /**
   * Boss Raid only. Shared danger zones and the squad radio — absent in every
   * other mode, where the two branches that read it simply never fire.
   */
  squad?: SquadChannel;
}

type Intent = 'engage' | 'retreat' | 'objective' | 'pickup' | 'patrol' | 'escort' | 'evade' | 'rescue' | 'heal';

/**
 * How long a medic keeps a patient after picking one, so two Isidas do not
 * swap patients every behaviour tick as the health bars cross each other.
 */
const PATIENT_CLAIM = 3;

/**
 * Fraction of beam range the healer holds at.
 *
 * Near the far end of it rather than comfortably inside: whatever is hurting
 * the patient badly enough to need a medic is, by definition, in range of the
 * patient — and a healer parked halfway between the two is in range of it too.
 * Measured across raid runs, closing this to the middle of the band roughly
 * quadrupled how often the squad's medic was the one dying.
 */
const HEAL_STANDOFF = 0.82;

/** How far behind the player an escorting medic parks itself. */
const ESCORT_GAP = 14;

/**
 * One bot. Decisions run on a 10 Hz behaviour tree over a blackboard; steering,
 * aiming and trigger discipline run every frame so movement stays smooth.
 *
 * The important design property is that the bot's *skill* lives entirely in
 * `Perception` (when it learns things) and in the aim-error model below (how
 * precisely it can act). It is never made weak or passive — a bot that fires
 * accurately once every two seconds with a 600 ms reaction reads as far more
 * alive than one that fires constantly and misses.
 */
export class BotController implements AiController {
  readonly perception: Perception;
  private readonly tree: Node<BotController>;

  intent: Intent = 'patrol';
  target: Tank | null = null;
  /** The ally this bot is currently putting its beam into, if any. */
  patient: Tank | null = null;
  private path: CANNON.Vec3[] = [];
  private pathIndex = 0;
  private goal: CANNON.Vec3 | null = null;
  private repathTimer = 0;
  private decisionAccum = randRange(0, TICK);
  private stuckTimer = 0;
  private unstickTimer = 0;
  private strafeSign = Math.random() < 0.5 ? -1 : 1;
  private strafeTimer = 0;
  private repositionTimer = 0;
  private jitterYaw = 0;
  private jitterPitch = 0;
  private jitterTimer = 0;
  private holdFire = 0;
  private chargeTimer = 0;
  private readonly reactionDelay: number;
  private lastPathAt = -99;
  /** Where the bot is running to get out of a marked blast zone, if anywhere. */
  private evadeTo: Escape | null = null;

  constructor(
    readonly self: Tank,
    readonly persona: Persona,
    private readonly deps: BotDeps,
  ) {
    const p = deps.profile.bot;
    this.reactionDelay = randRange(p.reactionDelayMs[0], p.reactionDelayMs[1]) * persona.reactionScale;
    this.perception = new Perception(self, {
      fovDegrees: p.fovDegrees,
      viewDistance: p.viewDistance,
      reactionDelayMs: this.reactionDelay,
      memoryDurationMs: 4500,
      losCheck: true,
      hearsGunfireRadius: 45,
    });
    this.tree = buildTree();
  }

  update(dt: number, now: number): void {
    if (!this.self.alive) return;

    this.decisionAccum += dt;
    if (this.decisionAccum >= TICK) {
      this.decisionAccum -= TICK;
      this.perception.update(this.deps.arena, now);
      this.tree.tick(this, TICK);
      this.considerSupplies();
      this.considerOverdrive();
    }

    this.updateAim(dt);
    this.updateFiring(dt);
    this.updateMovement(dt);
  }

  onDeath(): void {
    this.target = null;
    this.path = [];
    this.goal = null;
    this.evadeTo = null;
    this.intent = 'patrol';
    this.dropPatient();
  }

  // ---- healing ----------------------------------------------------------

  /**
   * Healing is a property of the gun, not of the personality behind it.
   *
   * Anything holding an Isida gets this branch, so a squad that happens to
   * field two of them has two healers rather than one healer and one bot
   * carrying a beam it never points at anybody. The persona only sets *how
   * readily* it diverts — see `healThreshold` — and a bot whose persona says
   * nothing about healing still tops up a squadmate that is genuinely in
   * trouble rather than watching them die with a repair beam in its hands.
   */
  get canHeal(): boolean {
    return this.self.turretDef.special?.includes('healsAllies') === true && this.healRange > 0;
  }

  private get healRange(): number {
    return this.self.turretDef.beam?.range ?? 0;
  }

  /** Health fraction below which an ally is worth diverting to. */
  private get healThreshold(): number {
    return this.persona.healThreshold > 0 ? this.persona.healThreshold : 0.7;
  }

  private patientKey(ally: Tank): string {
    return `heal:${ally.id}`;
  }

  private dropPatient(): void {
    if (!this.patient) return;
    this.deps.board.release(this.patientKey(this.patient), this.self.id);
    this.patient = null;
    this.self.weapon.preferBeamTarget(null);
  }

  /**
   * Who to heal. Ranked by how hurt they are and how far away, then claimed on
   * the team board — which is the whole mechanism that stops two Isidas piling
   * onto the same lightly-scratched squadmate while a third raider burns down
   * untouched. A medic that cannot get the claim takes the next name on the
   * list instead of arguing for it.
   */
  wantsToHeal(): boolean {
    if (!this.canHeal || this.self.carryingFlag) {
      // Carrying the flag outranks everything, healing included. A medic that
      // stops halfway home to top somebody up is a medic that loses the flag,
      // and the objective branch below this one never gets to run.
      this.dropPatient();
      return false;
    }
    const arena = this.deps.arena;
    const now = arena.time;
    const threshold = this.healThreshold;
    const reach = this.healRange * 3;
    const escorting = this.persona.escortsPlayer;
    const quarry = this.deps.squad?.rescue ?? null;

    const ranked: { tank: Tank; score: number }[] = [];
    for (const ally of arena.tanks) {
      if (ally === this.self || !ally.alive || ally.isBoss) continue;
      if (!arena.areAllies(this.self, ally)) continue;
      if (ally.healthFraction >= threshold) continue;
      const dist = ally.position.distanceTo(this.self.position);
      if (dist > reach) continue;
      let score = (1 - ally.healthFraction) * 140 - dist * 0.8;
      // The player is the one health bar in the fight somebody is watching.
      if (ally.isPlayer) score += escorting ? 45 : 15;
      // Whoever the Overseer has fixated on is losing health fastest.
      if (ally === quarry) score += 40;
      // Sticky: re-picking a patient every tick makes the beam stutter between
      // two people and heal neither.
      if (ally === this.patient) score += 25;
      ranked.push({ tank: ally, score });
    }
    if (!ranked.length) {
      this.dropPatient();
      return false;
    }
    ranked.sort((a, b) => b.score - a.score);

    for (const { tank } of ranked) {
      if (!this.deps.board.claim(this.patientKey(tank), this.self.id, now, PATIENT_CLAIM)) continue;
      if (this.patient && this.patient !== tank) this.dropPatient();
      this.patient = tank;
      return true;
    }
    // Everybody hurt is already somebody else's patient: go and fight instead.
    this.dropPatient();
    return false;
  }

  /** Where an escorting medic wants to be, or null if it is not escorting. */
  escortAnchor(): Tank | null {
    if (!this.persona.escortsPlayer) return null;
    const player = this.deps.arena.tanks.find((t) => t.isPlayer);
    if (!player || !player.alive || !this.deps.arena.areAllies(this.self, player)) return null;
    return player;
  }

  // ---- target selection -------------------------------------------------

  /**
   * Threat score. A bot tracks one target at a time and drops the rest, which
   * is what lets a player rotate between several bots freely.
   */
  selectTarget(): Tank | null {
    const tracks = this.perception.actionable();
    if (!tracks.length) return null;

    const keepCurrent =
      this.target &&
      this.target.alive &&
      tracks.some((t) => t.tank === this.target) &&
      Math.random() > this.deps.profile.bot.targetSwitchChance;
    if (keepCurrent) return this.target;

    let best: Tank | null = null;
    let bestScore = -Infinity;
    const from = this.self.centre();

    for (const track of tracks) {
      const dist = track.lastKnown.distanceTo(from);
      const [near, far] = preferredRange(this.self.turretDef);
      const bandFit = dist < near ? 0.6 : dist > far * 1.6 ? 0.3 : 1;
      let score = bandFit * 100 - dist * 0.4;
      // Finish wounded targets; that reads as intent rather than randomness.
      score += (1 - track.tank.healthFraction) * 55;
      if (track.tank.isPlayer) score += 12;
      if (track.tank.carryingFlag) score += 80;
      // Spread fire rather than every bot dogpiling one tank.
      score -= this.deps.board.focusCount(track.tank.id) * 14;
      if (score > bestScore) {
        bestScore = score;
        best = track.tank;
      }
    }
    if (best) this.deps.board.callTarget(best.id);
    return best;
  }

  currentTrack(): Track | null {
    return this.target ? (this.perception.get(this.target.id) ?? null) : null;
  }

  // ---- aiming -----------------------------------------------------------

  /**
   * Aim error shrinks the longer a bot holds a target, so a bot that catches
   * you in the open becomes progressively lethal — and breaking line of sight
   * resets it. That one mechanic does most of the work of looking intelligent.
   */
  private updateAim(dt: number): void {
    // A beam onto a squadmate is not a skill check, so it gets none of the
    // error model below: the medic points straight at them. What makes healing
    // hard for a bot is deciding who and getting there, not the last two
    // degrees of turret slew.
    const patient = this.intent === 'heal' ? this.patient : null;
    if (patient && patient.alive) {
      const muzzle = this.self.muzzle(new CANNON.Vec3());
      const delta = patient.centre().vsub(muzzle);
      const [minPitch, maxPitch] = this.self.pitchLimits;
      this.self.desiredYaw = Math.atan2(delta.x, delta.z);
      this.self.desiredPitch = clamp(Math.atan2(delta.y, Math.hypot(delta.x, delta.z)), minPitch, maxPitch);
      return;
    }

    const track = this.currentTrack();
    if (!track) {
      // Sweep the turret toward where the hull is heading when idle.
      const v = this.self.velocity;
      if (v.lengthSquared() > 1) this.self.desiredYaw = Math.atan2(v.x, v.z);
      else if (this.goal) {
        this.self.desiredYaw = Math.atan2(this.goal.x - this.self.position.x, this.goal.z - this.self.position.z);
      }
      this.self.desiredPitch *= 0.9;
      return;
    }

    const turret = this.self.turretDef;
    const muzzle = this.self.muzzle(new CANNON.Vec3());
    const aimAt = track.visible ? track.tank.centre() : track.lastKnown.clone();

    let point = aimAt;
    const speed = turret.projectileSpeed;
    if (speed && track.visible) {
      const p = predictIntercept(
        { x: muzzle.x, y: muzzle.y, z: muzzle.z },
        { x: aimAt.x, y: aimAt.y, z: aimAt.z },
        { x: track.tank.velocity.x, y: track.tank.velocity.y, z: track.tank.velocity.z },
        speed,
      );
      point = new CANNON.Vec3(p.x, p.y, p.z);
    }

    const delta = point.vsub(muzzle);
    const horizontal = Math.hypot(delta.x, delta.z);
    let yaw = Math.atan2(delta.x, delta.z);
    let pitch = Math.atan2(delta.y, horizontal);

    if (turret.gravity && speed) {
      // Ballistic turrets need real elevation, not a straight-line solution.
      const solved = ballisticElevation(horizontal, delta.y, speed, turret.gravity);
      if (solved != null) pitch = solved;
    }

    const p = this.deps.profile.bot;
    const slack = this.deps.slack();
    const convergence = clamp(p.trackingConvergence * track.timeOnTarget, 0, 0.95);
    const floor = p.minAimErrorDeg * this.persona.aimSkill * slack;
    const error = Math.max(floor, p.aimErrorDeg * this.persona.aimSkill * slack * (1 - convergence));

    this.jitterTimer -= dt;
    if (this.jitterTimer <= 0) {
      // Resampled a few times a second and interpolated between, so the
      // turret drifts rather than vibrating.
      this.jitterTimer = randRange(0.28, 0.5);
      const a = Math.random() * Math.PI * 2;
      const r = Math.sqrt(Math.random()) * error * DEG;
      this.jitterYaw = Math.cos(a) * r;
      this.jitterPitch = Math.sin(a) * r * 0.6;
    }

    yaw += this.jitterYaw;
    pitch += this.jitterPitch;

    const [minPitch, maxPitch] = this.self.pitchLimits;
    this.self.desiredYaw = yaw;
    this.self.desiredPitch = clamp(pitch, minPitch, maxPitch);
  }

  // ---- trigger discipline ----------------------------------------------

  private updateFiring(dt: number): void {
    const weapon = this.self.weapon;
    this.holdFire = Math.max(0, this.holdFire - dt);

    // Healing runs ahead of every trigger rule below it, because those rules
    // are about shooting: they gate on a perception track, and an ally is not
    // one. Without this branch an Isida bot holds a repair beam it is
    // structurally incapable of ever firing at a friend.
    const patient = this.intent === 'heal' ? this.patient : null;
    if (patient && patient.alive) {
      weapon.preferBeamTarget(patient);
      const muzzle = this.self.muzzle(new CANNON.Vec3());
      const to = patient.centre();
      const aimed = Math.abs(angleDelta(this.self.turretYaw, this.self.desiredYaw)) < (weapon.def.beam?.lockConeDeg ?? 12) * DEG;
      weapon.intent.alt = false;
      weapon.intent.scope = false;
      weapon.intent.fire = aimed && muzzle.distanceTo(to) <= this.healRange;
      return;
    }
    weapon.preferBeamTarget(null);

    const track = this.currentTrack();

    if (!track || !track.visible || this.holdFire > 0) {
      weapon.intent.fire = false;
      weapon.intent.alt = false;
      weapon.intent.scope = false;
      this.chargeTimer = 0;
      return;
    }

    const muzzle = this.self.muzzle(new CANNON.Vec3());
    const target = track.tank.centre();
    const dist = muzzle.distanceTo(target);
    const turret = this.self.turretDef;
    const cap = turret.hardCap ?? turret.rangeMinDamage * 1.4;
    if (dist > cap) {
      weapon.intent.fire = false;
      return;
    }

    // Only shoot when the turret has actually arrived; the aim error is the
    // handicap, not a permanently mis-pointed barrel.
    const aimError = Math.abs(angleDelta(this.self.turretYaw, this.self.desiredYaw));
    const gate = clamp(Math.atan2(3.5, Math.max(6, dist)), 1.2 * DEG, 14 * DEG);
    if (aimError > gate) {
      weapon.intent.fire = false;
      return;
    }
    if (!this.deps.arena.phys.lineOfSight(muzzle, target, this.self.vehicle.body)) {
      // Ricochet is the exception: bouncing round a corner is its whole point.
      if (turret.fireMode !== 'bouncing') {
        weapon.intent.fire = false;
        return;
      }
    }
    // Don't blow yourself up with your own splash.
    if (turret.selfDamage && turret.splash && dist < turret.splash.radius * 1.15) {
      weapon.intent.fire = false;
      return;
    }

    switch (turret.fireMode) {
      case 'sniper': {
        const wantScope = dist > 45 && this.self.vehicle.speed < 3;
        weapon.intent.scope = wantScope;
        if (wantScope) {
          this.chargeTimer += dt;
          const full = turret.scoped!.chargeTime;
          // Hold for a persona-flavoured fraction of the charge, then release.
          const want = full * (this.persona.id === 'sniper' ? 0.95 : 0.6);
          weapon.intent.fire = this.chargeTimer < want;
          if (this.chargeTimer >= want) this.chargeTimer = -0.4;
        } else {
          weapon.intent.fire = true;
        }
        break;
      }
      case 'guided':
      case 'hitscan':
        // Both auto-release: hold the trigger and let the weapon resolve it.
        weapon.intent.fire = true;
        break;
      case 'dual':
        weapon.intent.alt = dist > 40 && Math.random() < 0.35;
        weapon.intent.fire = !weapon.intent.alt;
        break;
      case 'minigun':
      case 'sustained':
      case 'cone':
      case 'beam':
      case 'chain':
        weapon.intent.fire = true;
        break;
      default:
        weapon.intent.fire = true;
        break;
    }

    if (weapon.ready && Math.random() < this.persona.repositionChance * dt) {
      this.strafeSign = -this.strafeSign;
    }
  }

  // ---- movement ---------------------------------------------------------

  setGoal(pos: CANNON.Vec3 | null, force = false): void {
    if (!pos) {
      this.goal = null;
      this.path = [];
      return;
    }
    const moved = !this.goal || this.goal.distanceTo(pos) > 6;
    this.goal = pos.clone();
    if (force || moved || this.repathTimer <= 0) this.repath();
  }

  private repath(): void {
    if (!this.goal) return;
    const now = this.deps.arena.time;
    // Hard cap on search rate: a dozen bots must not all repath on one frame.
    if (now - this.lastPathAt < 0.25 && this.path.length) return;
    this.lastPathAt = now;
    this.repathTimer = randRange(0.7, 1.3);
    this.path = this.deps.nav.findPath(
      this.self.position.x,
      this.self.position.z,
      this.goal.x,
      this.goal.z,
    );
    this.pathIndex = 0;
  }

  private updateMovement(dt: number): void {
    this.repathTimer -= dt;
    this.strafeTimer -= dt;
    this.repositionTimer -= dt;
    if (this.repathTimer <= 0 && this.goal) this.repath();

    const vehicle = this.self.vehicle;
    let forward = 0;
    let turn = 0;

    if (this.unstickTimer > 0) {
      this.unstickTimer -= dt;
      forward = -1;
      turn = this.strafeSign;
    } else {
      const steer = this.computeSteering();
      forward = steer.forward;
      turn = steer.turn;

      const wantsToMove = Math.abs(forward) > 0.1;
      if (wantsToMove && vehicle.speed < 0.8 && vehicle.isGrounded) {
        this.stuckTimer += dt;
        if (this.stuckTimer > 1.1) {
          this.unstickTimer = randRange(0.5, 0.9);
          this.stuckTimer = 0;
          this.strafeSign = -this.strafeSign;
          this.repathTimer = 0;
        }
      } else {
        this.stuckTimer = Math.max(0, this.stuckTimer - dt);
      }
    }

    if (vehicle.isInverted) vehicle.requestFlip();

    const speedScale = this.self.movementScale;
    vehicle.update(dt, {
      forward,
      turn,
      speedScale,
      locked: this.self.weapon.movementLocked,
    });
  }

  private computeSteering(): { forward: number; turn: number } {
    // Getting out of a ring is a straight-line sprint, not a navigation
    // problem: a bot that stops to path around a corner while a Quake winds up
    // has spent the whole warning on the search. Whisker avoidance below keeps
    // it off walls, which is all the steering a one-second dash needs.
    if (this.intent === 'evade' && this.evadeTo) {
      return this.avoid(this.driveTo(this.evadeTo.x, this.evadeTo.z));
    }
    // Healing and escorting are both "hold this distance from that tank", which
    // the navmesh is the wrong tool for once you are already next to them.
    if (this.intent === 'heal' && this.patient?.alive) {
      return this.avoid(this.stationOn(this.patient, this.healRange * HEAL_STANDOFF, this.healRange));
    }
    if (this.intent === 'escort') {
      const anchor = this.escortAnchor();
      if (anchor) return this.avoid(this.stationOn(anchor, ESCORT_GAP, ESCORT_GAP * 2.5));
    }
    // In an engagement, orbit the target inside the weapon's band instead of
    // driving the path blindly.
    const track = this.currentTrack();
    if (this.intent === 'engage' && track && track.visible) {
      return this.avoid(this.combatSteering(track));
    }
    return this.avoid(this.followPath());
  }

  /**
   * Hold station at `band` metres from another tank, following it as it moves.
   *
   * Beyond `handover` the navmesh does the work, because the gap is a
   * navigation problem — around a building, up a ramp. Inside it the path is
   * noise: the ally is right there, and what matters is keeping a clean line to
   * them rather than driving a route computed a second ago.
   */
  private stationOn(mate: Tank, band: number, handover: number): { forward: number; turn: number } {
    const self = this.self.position;
    const at = mate.position;
    let dx = self.x - at.x;
    let dz = self.z - at.z;
    const dist = Math.hypot(dx, dz);
    if (dist > handover) {
      this.setGoal(at);
      return this.followPath();
    }
    if (Math.abs(dist - band) < 2.5) {
      // Parked. Keep the hull square to them so a shove or a near miss does not
      // swing the whole tank — and with it the beam — off the patient.
      const bearing = Math.atan2(at.x - self.x, at.z - self.z);
      return { forward: 0, turn: clamp(angleDelta(this.self.vehicle.yaw, bearing) * 2, -1, 1) };
    }
    if (dist < 0.5) return { forward: -0.6, turn: 0 };
    dx /= dist;
    dz /= dist;
    return this.driveTo(at.x + dx * band, at.z + dz * band);
  }

  /** Point the hull at a world point and drive, slowing for hard turns. */
  private driveTo(x: number, z: number): { forward: number; turn: number } {
    const desired = Math.atan2(x - this.self.position.x, z - this.self.position.z);
    const delta = angleDelta(this.self.vehicle.yaw, desired);
    const turn = clamp(delta * 2.4, -1, 1);
    // Past a right angle it reverses out rather than swinging the hull round,
    // which is both faster and what a driver would do.
    const forward = Math.abs(delta) > 2.1 ? -1 : Math.abs(delta) > 1.1 ? 0.45 : 1;
    return { forward, turn };
  }

  // ---- the squad channel ------------------------------------------------

  /**
   * Ground the bot is standing on and should not be. Returns the zone only
   * while running still helps: a wind-up with a third of a second left is one
   * the bot is better off shooting through than being caught mid-turn by.
   */
  dangerHere(): DangerZone | null {
    const squad = this.deps.squad;
    if (!squad) return null;
    const zone = squad.threatAt(this.self.position, EVACUATE_MARGIN);
    if (!zone) return null;
    return zone.until - this.deps.arena.time > EVACUATE_GIVE_UP ? zone : null;
  }

  evacuate(): void {
    const squad = this.deps.squad;
    const zone = this.dangerHere();
    if (!squad || !zone) return;
    this.intent = 'evade';
    this.evadeTo = squad.escapeFrom(this.self.position, zone, EVACUATE_MARGIN);
    this.setGoal(null);
    // Keep shooting on the way out if the turret already has something. Running
    // is the priority; going quiet as well is a squad that contributes nothing
    // for a quarter of every fight.
    this.target = this.selectTarget();
    squad.say(this.self, 'evacuate', SquadChannel.line([...SQUAD_LINES.evacuate], this.self.id));
  }

  /**
   * The ally the boss has fixated on, if this bot is close enough to be part of
   * the answer. The rescue is damage, not proximity — but a squadmate that
   * abandons a position on the far side of the map contributes nothing except a
   * long drive, so the commitment has a range on it.
   */
  rescueBoss(): Tank | null {
    const squad = this.deps.squad;
    const quarry = squad?.rescue;
    const boss = squad?.boss;
    if (!squad || !quarry || !boss || !boss.alive) return null;
    if (quarry === this.self || !quarry.alive) return null;
    // A healer's contribution to a rescue is the quarry still being alive when
    // the rest of the squad breaks the mark. Sending it to add its own twenty
    // damage a second to four other guns, while the tank being hunted bleeds
    // out unattended, is the worse trade in every fight this mechanic appears in.
    if (this.canHeal && quarry.healthFraction < 1) return null;
    return boss.position.distanceTo(this.self.position) <= RESCUE_REACH ? boss : null;
  }

  callRescue(): void {
    const squad = this.deps.squad;
    const quarry = squad?.rescue;
    if (!squad || !quarry) return;
    const line = SquadChannel.line([...SQUAD_LINES.rescue], this.self.id);
    squad.say(this.self, 'rescue', quarry.isPlayer ? line : `${line} — ${quarry.name}`);
  }

  /**
   * Whisker avoidance. Combat steering ignores the navmesh by design — a bot
   * orbiting a target is not following a path — so something has to stop it
   * grinding along walls. Three short rays are enough, and it also smooths out
   * path following through doorways.
   */
  private avoid(steer: { forward: number; turn: number }): { forward: number; turn: number } {
    if (steer.forward <= 0) return steer;
    const phys = this.deps.arena.phys;
    const body = this.self.vehicle.body;
    const origin = this.self.centre();
    const yaw = this.self.vehicle.yaw;
    const reach = 4 + this.self.vehicle.speed * 0.9;

    let clearAhead = true;
    let bias = 0;
    for (const [offset, weight] of [
      [0, 0],
      [-0.5, 1],
      [0.5, -1],
    ] as const) {
      const a = yaw + offset;
      const to = new CANNON.Vec3(
        origin.x + Math.sin(a) * reach,
        origin.y,
        origin.z + Math.cos(a) * reach,
      );
      const hit = phys.raycast(origin, to, WORLD_MASK, body);
      if (!hit) continue;
      if (offset === 0) clearAhead = false;
      // Steer away from whichever whisker is blocked.
      bias += weight * (1 - hit.distance / reach);
    }
    if (clearAhead && bias === 0) return steer;

    const turn = clamp(steer.turn + bias * 1.6 + (bias === 0 ? this.strafeSign * 0.8 : 0), -1, 1);
    return { forward: clearAhead ? steer.forward : steer.forward * 0.45, turn };
  }

  private followPath(): { forward: number; turn: number } {
    const waypoint = this.currentWaypoint();
    if (!waypoint) return { forward: 0, turn: 0 };

    const toX = waypoint.x - this.self.position.x;
    const toZ = waypoint.z - this.self.position.z;
    const dist = Math.hypot(toX, toZ);
    if (dist < 3.2) {
      this.pathIndex += 1;
      return this.currentWaypoint() ? this.followPath() : { forward: 0, turn: 0 };
    }

    const desired = Math.atan2(toX, toZ);
    const delta = angleDelta(this.self.vehicle.yaw, desired);
    const turn = clamp(delta * 2.2, -1, 1);
    // Slow down for hard turns so the hull does not understeer into walls.
    const forward = Math.abs(delta) > 1.9 ? -0.5 : Math.abs(delta) > 1.0 ? 0.35 : 1;
    return { forward, turn };
  }

  private combatSteering(track: Track): { forward: number; turn: number } {
    const [near, far] = preferredRange(this.self.turretDef);
    const band = near + (far - near) * this.persona.standoff;
    const to = track.tank.centre().vsub(this.self.centre());
    const dist = Math.hypot(to.x, to.z);

    const bearing = Math.atan2(to.x, to.z);
    if (this.strafeTimer <= 0) {
      this.strafeTimer = randRange(1.4, 3.2);
      if (Math.random() < 0.4) this.strafeSign = -this.strafeSign;
    }

    let desired: number;
    let forward = 1;
    const tolerance = band * 0.22;
    if (dist > band + tolerance) {
      desired = bearing;
      forward = 1;
    } else if (dist < band - tolerance) {
      // Back off while keeping the hull pointed at the fight.
      desired = bearing;
      forward = this.persona.aggression > 0.85 ? 0.4 : -0.8;
    } else {
      // Orbit.
      desired = bearing + this.strafeSign * (Math.PI / 2);
      forward = 0.85;
    }

    const delta = angleDelta(this.self.vehicle.yaw, desired);
    const turn = clamp(delta * 2.2, -1, 1);
    if (forward > 0 && Math.abs(delta) > 1.6) forward = 0.3;
    return { forward, turn };
  }

  private currentWaypoint(): CANNON.Vec3 | null {
    while (this.pathIndex < this.path.length) {
      const wp = this.path[this.pathIndex];
      const d = Math.hypot(wp.x - this.self.position.x, wp.z - this.self.position.z);
      if (d > 2.4) return wp;
      this.pathIndex += 1;
    }
    return null;
  }

  hasPath(): boolean {
    return this.pathIndex < this.path.length;
  }

  /** A nearby point with no line of sight to the current threat. */
  findCover(threat: CANNON.Vec3): CANNON.Vec3 | null {
    const nav = this.deps.nav;
    const self = this.self.centre();
    let best: CANNON.Vec3 | null = null;
    let bestScore = -Infinity;

    for (let i = 0; i < 10; i++) {
      const angle = Math.random() * Math.PI * 2;
      const radius = randRange(14, 38);
      const x = self.x + Math.cos(angle) * radius;
      const z = self.z + Math.sin(angle) * radius;
      const idx = nav.nearestWalkable(x, z, 2);
      if (idx < 0) continue;
      const cell = nav.cellCentre(idx);
      const probe = new CANNON.Vec3(cell.x, cell.y + 1.4, cell.z);
      const blocked = !this.deps.arena.phys.raycast(probe, threat, WORLD_MASK) ? false : true;
      const away = cell.distanceTo(threat);
      const score = (blocked ? 120 : 0) + away * 0.8 - cell.distanceTo(self) * 0.4;
      if (score > bestScore) {
        bestScore = score;
        best = cell;
      }
    }
    return best;
  }

  patrolPoint(): CANNON.Vec3 {
    const nav = this.deps.nav;
    for (let i = 0; i < 8; i++) {
      const x = randRange(nav.originX, nav.originX + nav.cols * 3);
      const z = randRange(nav.originZ, nav.originZ + nav.rows * 3);
      const idx = nav.nearestWalkable(x, z, 2);
      if (idx >= 0) return nav.cellCentre(idx);
    }
    return this.self.position.clone();
  }

  // ---- supplies and overdrive ------------------------------------------

  private considerSupplies(): void {
    const p = this.deps.profile.bot;
    if (Math.random() > p.supplyUseChance * TICK * 4) return;

    const hp = this.self.healthFraction;
    const engaged = this.intent === 'engage' || this.intent === 'retreat';
    const order: SupplyKind[] = [];
    if (hp < 0.5) order.push('repair');
    if (engaged) order.push('armor', 'damage');
    if (this.intent === 'objective' || this.intent === 'pickup') order.push('nitro');
    if (engaged && hp > 0.6) order.push('mine');

    for (const kind of order) {
      if (this.self.canUseSupply(kind)) {
        this.self.useSupply(kind, this.deps.arena);
        return;
      }
    }
  }

  private considerOverdrive(): void {
    if (this.self.overdriveCharge < 100) return;
    const track = this.currentTrack();
    const wants =
      (track && track.visible) ||
      this.self.healthFraction < 0.4 ||
      (this.persona.healsAllies && this.nearbyWoundedAlly());
    if (!wants) return;
    // Bots hold their ultimate a beat too long and fire it a little at random —
    // deliberately worse timing than a player, without ever being passive.
    if (Math.random() < 0.35) return;
    this.pendingOverdrive = true;
  }

  pendingOverdrive = false;

  private nearbyWoundedAlly(): boolean {
    return this.deps.arena.tanks.some(
      (t) =>
        t !== this.self &&
        t.alive &&
        this.deps.arena.areAllies(this.self, t) &&
        t.healthFraction < 0.6 &&
        t.position.distanceTo(this.self.position) < 30,
    );
  }

  // ---- accessors used by the tree --------------------------------------

  get deps_(): BotDeps {
    return this.deps;
  }

  suppressFire(seconds: number): void {
    this.holdFire = Math.max(this.holdFire, seconds);
  }
}

function ballisticElevation(horizontal: number, height: number, speed: number, gravity: number): number | null {
  const s2 = speed * speed;
  const disc = s2 * s2 - gravity * (gravity * horizontal * horizontal + 2 * height * s2);
  if (disc < 0) return null;
  return Math.atan2(s2 - Math.sqrt(disc), gravity * horizontal);
}

/**
 * The decision tree from the spec: survive first, then the mode objective,
 * then contest pickups, then engage, then wander.
 */
function buildTree(): Node<BotController> {
  // Above survival, because the ground you are standing on resolving in one
  // second beats the health you have left. This branch and the rescue below it
  // are the only two that read the squad channel, and both are inert in every
  // mode that does not supply one.
  const evacuate = guard<BotController>(
    'Evacuate',
    (bb) => bb.dangerHere() !== null,
    action('GetOut', (bb) => {
      bb.evacuate();
      return 'running';
    }),
  );

  const rescue = guard<BotController>(
    'Rescue',
    (bb) => bb.rescueBoss() !== null,
    action('BreakTheMark', (bb) => {
      const boss = bb.rescueBoss()!;
      bb.intent = 'rescue';
      // The mark is broken by damage, so this is not "go and stand near your
      // squadmate" — it is "put your gun on the thing that is hunting them".
      bb.target = boss;
      bb.setGoal(boss.position);
      bb.callRescue();
      return 'running';
    }),
  );

  const survive = guard<BotController>(
    'Survive',
    (bb) =>
      bb.self.healthFraction < bb.persona.retreatHealth &&
      bb.self.lastAttackedAt > bb.deps_.arena.time - 4,
    action('Retreat', (bb) => {
      bb.intent = 'retreat';
      const threat = bb.target?.centre() ?? bb.currentTrack()?.lastKnown ?? null;
      if (threat) {
        const cover = bb.findCover(threat);
        if (cover) bb.setGoal(cover);
      }
      // Breaking line of sight also clears burning, which is why it matters.
      bb.suppressFire(0.4);
      if (bb.self.canUseSupply('repair')) bb.self.useSupply('repair', bb.deps_.arena);
      return 'running';
    }),
  );

  /**
   * Put the beam on somebody. Above the objective and above the rescue, and
   * deliberately so: everything below this branch is a bot deciding what to
   * shoot, and a healer that only heals once it has run out of things to shoot
   * is the bug this branch exists to fix. The Overseer's mark is broken by
   * damage, but a marked squadmate who is being healed through it survives long
   * enough for the rest of the squad to do that breaking.
   */
  const heal = guard<BotController>(
    'Heal',
    (bb) => bb.wantsToHeal(),
    action('Mend', (bb) => {
      bb.intent = 'heal';
      // No combat target while healing: the turret has exactly one thing to
      // point at, and `updateFiring` reads the patient rather than a track.
      // The goal is left to the steering, which is following a moving tank
      // rather than driving to a fixed point.
      bb.target = null;
      return 'running';
    }),
  );

  const objective = guard<BotController>(
    'Objective',
    (bb) => {
      const obj = bb.deps_.objective(bb.self);
      if (!obj) return false;
      // Critical objectives — carrying the flag home, recovering your own flag,
      // chasing an enemy carrier, holding a contested point — override persona
      // entirely. Without that, a rusher carrying the flag drops everything to
      // pick a fight the moment anything comes into view.
      const urgency = obj.weight >= 0.9 ? obj.weight : obj.weight * bb.persona.objectiveBias;
      return urgency > 0.75 || (!bb.perception.actionable().length && urgency > 0.2);
    },
    action('PlayObjective', (bb) => {
      const obj = bb.deps_.objective(bb.self)!;
      bb.intent = 'objective';
      bb.target = bb.selectTarget();
      bb.setGoal(obj.pos);
      return 'running';
    }),
  );

  const contestPickup = guard<BotController>(
    'ContestPickup',
    (bb) => {
      if (bb.intent === 'engage' && bb.currentTrack()?.visible) return false;
      const p = bb.deps_.nearestPickup(bb.self.position);
      if (!p) return false;
      const dist = p.pos.distanceTo(bb.self.position);
      // Gold boxes are worth a long drive; supply boxes only a short one.
      return dist < 30 * p.value;
    },
    action('GoToPickup', (bb) => {
      const p = bb.deps_.nearestPickup(bb.self.position)!;
      const key = `pickup:${Math.round(p.pos.x)}:${Math.round(p.pos.z)}`;
      if (!bb.deps_.board.claim(key, bb.self.id, bb.deps_.arena.time)) return 'failure';
      bb.intent = 'pickup';
      bb.target = bb.selectTarget();
      bb.setGoal(p.pos);
      return 'running';
    }),
  );

  const engage = selector<BotController>('Engage', [
    condition('HasTarget', (bb) => {
      bb.target = bb.selectTarget();
      return bb.target !== null;
    }),
    action('NoTarget', () => 'failure' as Status),
  ]);

  const engageBranch = guard<BotController>(
    'EngageBranch',
    (bb) => engage.tick(bb, TICK) === 'success',
    action('Fight', (bb) => {
      bb.intent = 'engage';
      const track = bb.currentTrack();
      if (track && !track.visible) {
        // Push to the last known position rather than standing still.
        bb.setGoal(track.lastKnown);
      } else {
        bb.setGoal(null);
      }
      return 'running';
    }),
  );

  /**
   * Nobody to heal and nothing worth chasing: get back to the player.
   *
   * This is what makes the Medic a *dedicated* healer rather than a bot that
   * happens to carry an Isida. Without it the healer wanders off on the same
   * patrol as everyone else and is thirty metres out of beam range at the exact
   * moment the player needs it — which, from the player's seat, is
   * indistinguishable from not having a healer at all.
   */
  const escort = guard<BotController>(
    'Escort',
    (bb) => bb.escortAnchor() !== null,
    action('StayWithThem', (bb) => {
      bb.intent = 'escort';
      // Nothing to shoot at — this branch is only reached once the engage
      // branch above has failed to find a target — so the turret idles and the
      // hull closes the gap.
      bb.target = null;
      return 'running';
    }),
  );

  const patrol = action<BotController>('Patrol', (bb) => {
    bb.intent = 'patrol';
    bb.target = null;
    if (!bb.hasPath()) bb.setGoal(bb.patrolPoint(), true);
    return 'running';
  });

  return selector('Root', [
    evacuate,
    rescue,
    survive,
    heal,
    objective,
    contestPickup,
    engageBranch,
    escort,
    patrol,
  ]);
}
