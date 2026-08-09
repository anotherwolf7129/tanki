import { clamp } from '../core/mathx';
import type { HullDef } from './schema';

/**
 * Boss Raid tuning. One squad — you plus a handful of allied bots — against a
 * single Overseer that is far tougher and materially smarter than a line bot.
 *
 * The mode's whole design sits on one tension, and every number here serves it:
 * you deal far more damage to the boss than your squadmates do, and the boss
 * decides who to shoot by accumulated damage. Your advantage *is* what puts you
 * in front of the gun. Managing that — trading aggro with the squad, working
 * round to the engine deck while it is busy elsewhere — is the mode.
 *
 * The raid is meant to be *hard*. Nobody runs out of lives — the squad comes
 * back forever — so the only two things that can end a raid badly are the clock
 * and the Overseer healing faster than you hurt it. That is what every number
 * below is aimed at: dying is expensive in tempo, never in tickets.
 */

/** The boss's hull and gun. Neither is available in the garage. */
export const BOSS_HULL = 'juggernaut';
export const BOSS_TURRET = 'cataclysm';
export const BOSS_NAME = 'OVERSEER';

/**
 * What the Overseer has fitted. Authored rather than rolled, because the raid is
 * balanced against this exact boss: Incendiary is the reason standing in its
 * blast still costs you after you have driven out of it, and the reactor is why
 * Purge comes back around inside a single raid.
 */
export const BOSS_TURRET_AUGMENT = 'cataclysm.incendiary';
export const BOSS_HULL_AUGMENT = 'juggernaut.siege_reactor';

/**
 * Health pool. Sized so a full squad needs several sustained minutes rather
 * than one good burst, and so adding a squadmate lengthens the fight instead of
 * trivialising it.
 */
export const BOSS_BASE_HEALTH = 22000;
export const BOSS_HEALTH_PER_ALLY = 5000;

/**
 * How much of your damage lands, and how much of theirs. The gap is deliberate
 * and shown in the garage: you are the raid's damage, the squad is its noise.
 */
export const PLAYER_BOSS_DAMAGE = 2;
export const ALLY_BOSS_DAMAGE = 0.45;

/**
 * Squadmates run full-tier hulls instead of the bot equipment gap. They keep
 * the bot turret tier, so the damage advantage above is untouched — this buys
 * them survival, not output. A raid squad on line-bot armour simply evaporates
 * under the first barrage, and a boss fight with nobody else left standing is
 * not a raid.
 */
export const ALLY_HULL_MULTIPLIER = 1;

/**
 * Siege ordnance: the multiplier on everything the Overseer does to a raider.
 *
 * The Cataclysm was authored as a tank gun and the boss is not fighting tanks,
 * it is besieging them. A direct hit lands for the shell plus its own blast, so
 * at ×1.20 a light hull comes out of one the other side on a sliver — the
 * "almost" is the whole point. You are allowed exactly one mistake.
 */
export const BOSS_LETHALITY = 1.2;

/**
 * And how that lands on each hull class. Small hulls are what the gun is sized
 * against; heavy hulls are the answer to it. This is the one place in the game
 * where hull class changes how much damage you take rather than only how much
 * you have, and it exists so that "bring something that survives a shell" is a
 * real decision at the garage rather than a shrug.
 */
export const BOSS_CLASS_LETHALITY: Record<HullDef['class'], number> = {
  light: 1.28,
  medium: 1,
  heavy: 0.86,
  special: 0.8,
};

/**
 * Rear-arc bonus. A direct hit landing behind the boss's shoulders strikes the
 * engine deck. This is the skill expression the mode is built around: the boss
 * actively keeps its back to walls and turns to face whoever hurts it most, so
 * a breach costs you a real manoeuvre rather than a lucky angle.
 */
export const BREACH_MULTIPLIER = 1.6;
/** Cosine of the bearing beyond which a hit counts as a rear-arc hit. */
export const BREACH_COS = -0.35;

/**
 * Battle points per point of damage dealt to the boss. There is only one thing
 * to kill in a raid, so the scoreboard has to pay for the work rather than the
 * killing blow — otherwise a squadmate who tanked for four minutes reads as
 * having done nothing.
 */
export const POINTS_PER_DAMAGE = 0.012;

/**
 * Reinforcements are unlimited — the squad always comes back. What a death
 * costs is *time*, and the price rises with every one the raid has taken.
 *
 * This replaces the old shared ticket pool, which failed in both directions: a
 * raid that was winning never noticed it, and a raid that was losing was ended
 * by an accountant rather than by the boss. A climbing respawn delay is the
 * same pressure applied where you can feel it — the longer the squad has been
 * dying, the longer the Overseer is left alone with its repair kits.
 */
export const RESPAWN_BASE = 4;
export const RESPAWN_PER_LOSS = 0.25;
export const RESPAWN_MAX = 12;

export function respawnDelayFor(losses: number): number {
  return Math.min(RESPAWN_MAX, RESPAWN_BASE + RESPAWN_PER_LOSS * Math.max(0, losses));
}

/**
 * Repair. This exists to stop a losing raid simply refusing to fight and
 * running out the clock, and it is deliberately narrow: the boss has to be both
 * unhurt for this long *and* unable to see anyone. A squad that is dying and
 * respawning is still fighting, so the natural rhythm of a raid never feeds it.
 *
 * It also cannot undo a phase. Whatever gate the raid has pushed it through
 * stays pushed — every heal the boss has, from regeneration to its own repair
 * kits, is clamped to the top of the phase it is currently in — so a long fight
 * is always progress even when it goes badly.
 */
export const REGEN_DELAY = 10;
/** Fraction of its maximum health the boss repairs per second while left alone. */
export const REGEN_PER_SECOND = 0.0008;
/**
 * And how much faster it works while the entire raid is dead at once. A wipe no
 * longer ends the fight, so it has to cost something: the boss spends those
 * seconds patching, and the squad comes back to a healthier target.
 */
export const WIPE_REGEN_MULTIPLIER = 6;

/**
 * The Overseer carries field supplies like everyone else, and uses them for the
 * same reason you do. Repair kits are the interesting one: the heal-over-time
 * half is interrupted by damage exactly as yours is, so a boss that has just
 * cracked one open is a boss you can punish for it. That is the whole design —
 * it is not a heal, it is a window.
 */
export const BOSS_REPAIR_KITS = 4;
export const BOSS_ARMOR_KITS = 3;
export const BOSS_DAMAGE_KITS = 2;
/** Health fraction below which it will spend a repair kit. */
export const BOSS_REPAIR_AT = 0.72;
/** Seconds of not being shot it wants first, unless it is desperate. */
export const BOSS_REPAIR_QUIET = 1.6;
/** Below this it stops waiting for quiet and just uses the kit. */
export const BOSS_REPAIR_DESPERATE = 0.3;
/** How far it will detour for a supply box, and how hurt it has to be to bother. */
export const BOSS_BOX_REACH = 75;
export const BOSS_BOX_AT = 0.8;

export interface RaidPhase {
  index: number;
  name: string;
  /** Health fraction at or below which this phase becomes active. */
  from: number;
  /** Multiplier on every ability cooldown. */
  cooldownScale: number;
  /** Shells in a Siege Barrage salvo. */
  shells: number;
  /** Rocks in a Meteor Storm. */
  meteors: number;
  /** Rounds the main gun puts downrange per trigger pull. */
  salvo: number;
  /** Fan angle between salvo rounds, in degrees. */
  salvoSpreadDeg: number;
  /** Multiplier on hull top speed, turn rate and lateral grip. */
  speedScale: number;
  /** Multiplier on everything the boss does to a raider, on top of lethality. */
  damageScale: number;
  /** Berserk: permanently supercharged, permanently charging, from here down. */
  enraged?: boolean;
  blurb: string;
}

/**
 * Phases change tempo, volume, speed and force — never armour. A boss that
 * quietly gains armour reads as cheating; a boss that shortens its cooldowns,
 * fans four shells out of one barrel, hits half again as hard and comes at you
 * twice as fast reads as *angry*, and every one of those is still something you
 * can see coming and move away from.
 *
 * The escalation is deliberately front-loaded onto the two stats a raider feels
 * in their hands rather than reads off the HUD: how fast the thing closes, and
 * how much is left of them when it connects. Everything else — salvo size,
 * cooldowns, storm density — is dressing on those two.
 *
 * Each gate is crossed exactly once — the boss can never heal back through one
 * — and crossing it slams the raid off it with a pressure wave, so a phase
 * change is an event rather than a number quietly changing on the HUD.
 */
export const RAID_PHASES: RaidPhase[] = [
  {
    index: 1,
    name: 'Advance',
    from: 1,
    cooldownScale: 1,
    shells: 3,
    meteors: 4,
    salvo: 1,
    salvoSpreadDeg: 0,
    speedScale: 1,
    damageScale: 1,
    blurb: 'Holds the middle distance and picks off whoever hurts it most.',
  },
  {
    index: 2,
    name: 'Siege',
    from: 0.66,
    cooldownScale: 0.72,
    shells: 4,
    meteors: 6,
    salvo: 2,
    salvoSpreadDeg: 4,
    speedScale: 1.2,
    damageScale: 1.15,
    blurb: 'Two shells a pull, denser storms, and it starts throwing its weight around.',
  },
  {
    index: 3,
    name: 'Meltdown',
    from: 0.33,
    cooldownScale: 0.5,
    shells: 6,
    meteors: 9,
    salvo: 3,
    salvoSpreadDeg: 5.5,
    speedScale: 1.5,
    damageScale: 1.4,
    blurb: 'Abilities on a short leash, three shells a pull, and it runs stragglers down.',
  },
  {
    index: 4,
    name: 'Wrath',
    from: 0.15,
    cooldownScale: 0.34,
    shells: 7,
    meteors: 13,
    salvo: 4,
    salvoSpreadDeg: 7,
    speedScale: 1.85,
    damageScale: 1.75,
    enraged: true,
    blurb: 'Berserk. Faster and harder-hitting the closer it gets to dying, and it stops managing range entirely.',
  },
];

export function phaseFor(healthFraction: number): RaidPhase {
  let phase = RAID_PHASES[0];
  for (const p of RAID_PHASES) if (healthFraction <= p.from) phase = p;
  return phase;
}

/**
 * Berserk is not a switch, it is a slope.
 *
 * Inside the last phase the Overseer keeps getting worse the closer it is to
 * dying: 0 at the top of Wrath, 1 at zero health. A boss that hit its final
 * form at 15% and then stayed there spends the most dramatic stretch of the
 * fight standing still, tuning-wise. This is what makes the last sliver of the
 * bar the part people remember — it is fastest and hardest-hitting in the
 * seconds before it dies.
 */
export function frenzyFor(healthFraction: number): number {
  const last = RAID_PHASES[RAID_PHASES.length - 1];
  if (!last.enraged || healthFraction >= last.from) return 0;
  return clamp(1 - healthFraction / last.from, 0, 1);
}

/** What full frenzy adds on top of the Wrath phase's own numbers. */
export const FRENZY_SPEED_BONUS = 0.45;
export const FRENZY_DAMAGE_BONUS = 0.5;
export const FRENZY_FIRE_RATE_BONUS = 0.4;

/**
 * Ceiling on the hull-speed multiplier, Overcharge and all. A six-tonne hull
 * doing 22 m/s is already a thing you cannot outrun in anything but a light —
 * past that it stops being frightening and starts being a physics bug.
 */
export const BOSS_SPEED_CAP = 2.6;

export function bossSpeedScale(healthFraction: number): number {
  return phaseFor(healthFraction).speedScale + FRENZY_SPEED_BONUS * frenzyFor(healthFraction);
}

export function bossDamageScale(healthFraction: number): number {
  return phaseFor(healthFraction).damageScale + FRENZY_DAMAGE_BONUS * frenzyFor(healthFraction);
}

/** Fire-rate multiplier the boss keeps once enraged, plus its frenzy ramp. */
export const ENRAGE_FIRE_RATE = 1.45;

export function bossFireRate(healthFraction: number): number {
  return ENRAGE_FIRE_RATE + FRENZY_FIRE_RATE_BONUS * frenzyFor(healthFraction);
}

/**
 * Ramming. Once it is moving at siege speed the Overseer stops going *around*
 * raiders, and a six-tonne hull arriving at 15 m/s has to mean something — a
 * boss that can only hurt you with its gun is a boss you solve by hugging it,
 * which is precisely the ground its speed increase was meant to take away.
 */
export const RAM_FROM_PHASE = 2;
/** Metres of clearance beyond the two hulls' half-spans that still counts. */
export const RAM_REACH = 1.6;
/** Hull speed below which a shunt is just a shunt. */
export const RAM_MIN_SPEED = 5.5;
export const RAM_DAMAGE = 260;
/** Extra damage per metre per second over that, and the window it counts over. */
export const RAM_SPEED_BONUS = 30;
export const RAM_SPEED_WINDOW = 8;
export const RAM_IMPULSE = 22;
/** Seconds before the same raider can be run over again. */
export const RAM_COOLDOWN = 1.1;
/** Blast the boss throws off as it crosses a phase gate, to break the stack on it. */
export const PHASE_PULSE_RADIUS = 26;
export const PHASE_PULSE_DAMAGE = 380;
export const PHASE_PULSE_IMPULSE = 24;

/** Difficulty scales the boss's pool through the same knob bots are tuned by. */
export function bossHealth(allyCount: number, hullTierMultiplier: number): number {
  const pool = BOSS_BASE_HEALTH + BOSS_HEALTH_PER_ALLY * Math.max(0, allyCount);
  return Math.round(pool * (hullTierMultiplier / 0.7));
}

export interface BossAbilityDef {
  id: 'quake' | 'meteor' | 'barrage' | 'overcharge';
  displayName: string;
  /** Seconds of visible wind-up before the ability resolves. */
  windup: number;
  cooldown: number;
  /** Warning pushed to the kill feed when the wind-up starts. */
  warning: string;
}

export const BOSS_ABILITIES: Record<BossAbilityDef['id'], BossAbilityDef> = {
  quake: {
    id: 'quake',
    displayName: 'Quake',
    windup: 1.1,
    cooldown: 17,
    warning: 'OVERSEER is winding up a Quake — get out of the ring',
  },
  meteor: {
    id: 'meteor',
    displayName: 'Meteor Storm',
    windup: 2.4,
    cooldown: 27,
    warning: 'OVERSEER IS CALLING DOWN A METEOR STORM — SCATTER',
  },
  barrage: {
    id: 'barrage',
    displayName: 'Siege Barrage',
    windup: 1.4,
    cooldown: 15,
    warning: 'OVERSEER is ranging a Siege Barrage — cover will not save you',
  },
  overcharge: {
    id: 'overcharge',
    displayName: 'Overcharge',
    windup: 0.9,
    cooldown: 26,
    warning: 'OVERSEER is overcharging — it is coming for someone',
  },
};

export const QUAKE_RADIUS = 19;
export const QUAKE_DAMAGE_CENTRE = 550;
export const QUAKE_DAMAGE_EDGE = 200;
export const QUAKE_IMPULSE = 9;

/**
 * Meteor Storm — the Overseer stops fighting the raid and starts shelling the
 * ground the raid is standing on.
 *
 * Rocks come in off the top of the sky on a steep line, one every third of a
 * second, walking across wherever it last accounted for somebody. Each one
 * paints a closing ring on the ground for its whole flight, so every single
 * impact is a place you had a second and a half to not be standing — and each
 * one that connects takes a light hull off the map outright.
 *
 * The part that makes it *the* boss ability rather than a bigger barrage: the
 * Overseer does not aim these around itself. It is calling ordnance down on
 * coordinates, and it is standing in the coordinates. It eats a reduced share
 * of its own storm, which turns the whole ability into a two-way trade — a raid
 * that holds its nerve and fights *inside* the storm is a raid doing damage the
 * boss is doing to itself. Running away is safe and slow; standing next to it
 * while the sky comes down is fast and very nearly suicide. That choice is the
 * best thirty seconds the mode has.
 *
 * It replaces Structural Collapse, which asked the same question — where are
 * you hiding? — and answered it with a prop falling over.
 */
export const METEOR_ALTITUDE = 95;
/** Entry angle off the horizontal. Steep, but not vertical: a meteor has a line. */
export const METEOR_ENTRY_DEG = 68;
export const METEOR_SPEED = 62;
export const METEOR_INTERVAL = 0.3;
/** Scatter around the point it aimed at, so a storm walks rather than stacks. */
export const METEOR_SPREAD = 8;
/** Straight through a hull. Flat with range — this is not a ranged shot. */
export const METEOR_DIRECT = 900;
export const METEOR_SPLASH_RADIUS = 11;
export const METEOR_SPLASH_MAX = 1150;
export const METEOR_SPLASH_MIN = 320;
/**
 * Enough to throw a light hull off its wheels, and no more. This was 30 and had
 * to come down: with six to thirteen impacts a storm the raid stopped being
 * shoved and started being juggled, and a squad that spends the fight airborne
 * is a squad that never fires. The harness saw the boss surviving at twice the
 * health it does now for exactly that reason — the knockback was doing more to
 * the raid's damage output than the damage was.
 */
export const METEOR_IMPULSE = 20;
export const METEOR_SHELL_RADIUS = 0.85;
/**
 * The share of its own ordnance the Overseer takes — storm, barrage and the
 * blast off its own main gun alike. Armoured against weapons it designed, not
 * immune to them.
 *
 * A quarter, and that number was measured rather than picked. At a half, a
 * berserk Overseer — which charges raiders, and therefore charges the ground it
 * is shelling — was doing as much damage to itself as the whole raid was, and a
 * boss that mostly suicides is a boss the raid did not beat. At a quarter it is
 * a real bonus for holding your ground under a storm, and still the occasional
 * killing blow, without ever being the raid's main source of damage.
 */
export const BOSS_SELF_DAMAGE = 0.25;

/**
 * Blast discipline — the rule that makes the Overseer's own splash a constraint
 * on it rather than a fact about it.
 *
 * Its gun throws a nine-metre detonation and it is now inside that number like
 * everybody else, so it will not pull the trigger when the round — or any shell
 * in the fan behind it — would land inside this multiple of its own blast
 * radius. That is what stops a boss with its back to a wall firing into the
 * wall, and what stops a berserk one that has closed to ramming distance
 * detonating a siege shell on its own glacis.
 *
 * Enough clearance to keep the whole blast off itself, and no more: a boss that
 * refuses to shoot anything inside thirty metres is a boss you beat by walking
 * up to it.
 */
export const BLAST_CLEARANCE = 1.15;
/**
 * And what it learns the hard way. Geometry cannot predict a raider reversing
 * into the shell, or a rock landing where the boss is about to shoot, so every
 * blast that does catch it widens the ring it refuses to fire inside. The first
 * one is announced — it *shoots once and works it out*, which reads as a thing
 * that thinks rather than a thing that was written not to miss.
 */
export const BLAST_LESSON_STEP = 0.18;
export const BLAST_CLEARANCE_MAX = 1.7;
/**
 * Seconds a shot it will not take keeps the boss looking for better ground.
 * Long enough to survive the gap between two decision ticks, short enough that
 * the raider stepping back out of its face un-jams the gun immediately.
 */
export const BLAST_HOLD = 1.2;

export const BARRAGE_SPEED = 78;
export const BARRAGE_GRAVITY = 24;
export const BARRAGE_INTERVAL = 0.32;
export const BARRAGE_DAMAGE = 400;
export const BARRAGE_SPLASH_RADIUS = 10;
export const BARRAGE_SPREAD = 6;

export const OVERCHARGE_DURATION = 9;

/**
 * ---- The fear layer ---------------------------------------------------
 *
 * Everything above this line makes the Overseer *dangerous*. Danger is a
 * number: it is read off the HUD, solved with a hull choice, and after two
 * raids it is arithmetic. Fear is a different thing and it is not made of
 * bigger numbers — a boss nobody is frightened of does not get less frightening
 * when its damage goes up, it just gets more annoying.
 *
 * Fear is made of three things this fight did not have, and the constants below
 * are those three things:
 *
 *  - **Presence.** Something between the abilities. The Overseer used to be a
 *    normal tank fight punctuated by scheduled events; now it is felt through
 *    the floor for as long as it is near, and the pressure has a gradient you
 *    can hear closing behind you.
 *  - **Attention.** Being *chosen*, by name, and knowing that nothing you
 *    personally do will change its mind. The aggro meter is a slider you
 *    manage; the mark is a decision that has already been taken about you.
 *  - **Contrast.** Stillness before violence. The wind-up used to get louder
 *    all the way to the strike, which is the one shape that cannot frighten
 *    anybody: a noise that rises predictably is a noise you stop hearing.
 */

/**
 * The Mark — the piece that turns aggro into a hunt.
 *
 * From Siege onward the Overseer periodically stops arbitrating between four
 * threat scores and simply *picks somebody*. While a raider is marked the
 * threat table is not consulted at all: it drives at them, aims everything at
 * them, and will not be distracted by the squadmate hammering its engine deck.
 *
 * This is deliberately the one mechanic in the mode a raider cannot solve
 * alone, and that is the entire point of it. Every other threat in this file is
 * something you personally can answer — move out of the ring, bring a heavy
 * hull, stop out-damaging the squad. The mark is answered by the *squad*: it
 * breaks when somebody else does enough damage to drag its head round. Being
 * hunted by something you cannot shake, while you wait to find out whether your
 * team is going to come and get it off you, is a feeling no amount of extra
 * shell damage buys.
 *
 * Which is also why it must never be a death sentence. There are three ways out
 * — the squad breaks it, you survive the clock, or it catches you — and a raid
 * that knows all three is a raid that is frightened rather than cheated.
 */
export const MARK_FROM_PHASE = 2;
/**
 * Seconds between hunts. Long, and deliberately *not* scaled flat by the
 * phase's cooldown multiplier the way its abilities are.
 *
 * At the full ability scale a Wrath-phase Overseer would be hunting somebody
 * for more than half of every minute, and a fixation that is running most of
 * the time is not a fixation — it is just how the boss targets, and the whole
 * effect dies. The blunted curve below keeps the hunt at roughly a quarter of
 * the fight at every phase: more often when it is angry, never ambient.
 */
export const MARK_COOLDOWN = 34;
export function markCooldownFor(cooldownScale: number): number {
  return MARK_COOLDOWN * (0.6 + 0.4 * cooldownScale);
}
/** How long it stays fixated if nothing breaks it. */
export const MARK_DURATION = 9;
/**
 * Damage from *anyone but the quarry* that pulls its head round.
 *
 * Sized so that one squadmate deciding to be a hero is not enough and the squad
 * turning together is, because the interesting version of this mechanic is the
 * one where the rescue has to be chosen. That intent was originally written as
 * 2400 and it was simply wrong: the harness called thirty-one hunts across
 * three fights and the squad broke exactly none of them, because a raid puts
 * roughly five hundred points into the boss over a nine-second window and no
 * amount of commitment doubles that four times over.
 *
 * A threshold nobody ever reaches is not a hard mechanic, it is an absent one —
 * and worse than absent here, because the promise the HUD makes to the marked
 * raider is that help is possible.
 *
 * So this one is measured, not reasoned — and measuring it needed the harness
 * fixed first, because the obvious way to count a rescue is wrong: the tick
 * that pushes the bar past this number also clears the mark, so a successful
 * break is never *observed* at a full bar and every one of them was being filed
 * as a timeout. Read that way the mechanic looked dead at every threshold.
 *
 * Counted properly, against time left on a living quarry, this lands where it
 * should. Roughly half of all hunts end in a rescue, a little under half run
 * their course, and the rest end with the Overseer catching somebody — three
 * live outcomes rather than one. Lower and passive chip damage alone pulls it
 * off, which costs the hunt its teeth; higher and the squad cannot answer at
 * all, which costs it its point.
 */
export const MARK_BREAK_DAMAGE = 1200;
/**
 * A hunt is faster than a fight. Small — the fear is the fixation, not the
 * speed, and the escalation slope already owns that stat.
 */
export const MARK_SPEED_BONUS = 0.15;

/**
 * The Stillness.
 *
 * The last stretch of every wind-up, in which the Overseer stops. The pulsing
 * ring stops, the tracks stop, and for a beat the loudest thing on the field is
 * doing nothing at all.
 *
 * It costs the boss something real — that beat is a free shot at a stationary
 * six-tonne target, and it is the fairest window in the fight — and it buys the
 * only thing that makes an incoming ability land in the stomach rather than on
 * the health bar. A raid learns to read it within one fight and never stops
 * flinching at it, which is the exact difference between a tell and a threat.
 */
export const TELEGRAPH_STILLNESS = 0.72;

/**
 * It feeds.
 *
 * Nobody runs out of lives, so dying costs tempo and nothing else — and a death
 * that costs only tempo is a death nobody is afraid of. This is the stake the
 * mode was missing: the Overseer patches itself with what is left of whoever it
 * just killed, and the bar the whole raid is watching goes *up*.
 *
 * Clamped to the phase ceiling like every other heal it has, so a squad that is
 * wiping repeatedly loses tempo and morale but can never be pushed back through
 * a gate it has already bought. Progress stays permanent; only the mood gets
 * worse.
 *
 * The number is small because it was measured rather than picked, and the first
 * pick was five times this. The harness found the failure mode immediately: a
 * struggling raid takes upward of thirty deaths in a fight, and at 2% a pop
 * that is three quarters of the boss's pool handed back. The bar simply welded
 * itself to the phase ceiling and the raid made no progress inside a phase at
 * all — the exact "beaten by an accountant" outcome the ticket pool was deleted
 * for. Under half a percent it does what it is for: you see it happen, you feel
 * it, and it never becomes the reason the raid failed.
 */
export const KILL_HEAL_FRACTION = 0.005;

/**
 * Presence — the dread floor.
 *
 * A rumble through the hull that rises as the Overseer closes, scaled by how
 * fast it is actually moving. No damage, no mechanic, nothing to counter: it
 * exists so that the twenty seconds between abilities stop being a normal tank
 * fight, and so that a raider who has lost track of it finds out through the
 * floor rather than by turning round.
 *
 * The radius is deliberately longer than its gun is comfortable at, so the
 * rumble arrives before the shell does.
 */
export const DREAD_RADIUS = 52;
/** Peak shake contributed per second at zero range and full speed. */
export const DREAD_SHAKE = 0.5;

/**
 * ---- Demolition -------------------------------------------------------
 *
 * The arena as a resource the Overseer can spend.
 *
 * Every other escalation in this file happens to the boss: it moves faster, it
 * hits harder, it puts more shells in the air. Those are all things a raid
 * answers by playing better. This one is subtractive and permanent — the wall
 * the raid held the first phase behind is not there in the third — and it is
 * the only pressure in the mode that a raid cannot answer by improving, only by
 * moving. A boss that gets angrier is a difficulty curve. A boss that is
 * dismantling the room is a different fight every two minutes.
 *
 * It is also the honest version of a line the mode has always printed: the
 * Siege Barrage's warning says *cover will not save you*, and until now that
 * meant "the shells arc over it". Now it means the cover is gone.
 *
 * Only the Overseer's own ordnance does this. Raiders shooting a wall leave it
 * standing, because cover is the raid's resource and the point is that the boss
 * is the only thing that can take it away.
 */

/**
 * Integrity per cubic metre of prop, before material toughness — and the knob
 * that decides how fast the room disappears. Measured with the harness: at 7,
 * four hundred simulated seconds took down between zero and two structures
 * across three runs, which is a system that exists in the code and not in the
 * fight. Around 2 a raid loses the ground it is standing on over a phase, which
 * is the timescale a boss fight actually has.
 */
export const STRUCTURE_INTEGRITY_PER_M3 = 2.2;
export const STRUCTURE_INTEGRITY_MIN = 400;
export const STRUCTURE_INTEGRITY_MAX = 14000;

/**
 * Footprint above which a ground-level prop is *terrain* rather than cover, and
 * exempt.
 *
 * Maps are authored out of the same 5 m prop kit as the buildings, so the thing
 * holding up half of Kungur is a 200 × 40 m box that is structurally identical
 * to a wall — and the first version of this system was perfectly happy to
 * collapse it into a rubble field the size of the map, taking the spawns, the
 * ramps and everything standing on it with it. Anything with a footprint this
 * large is the floor, and the floor is not part of the fight.
 */
export const TERRAIN_FOOTPRINT = 400;
/** And the same ceiling for elevated decks, which are landforms at some size. */
export const DECK_FOOTPRINT_MAX = 900;

/** How much punishment each material soaks, relative to concrete. */
export const STRUCTURE_TOUGHNESS: Record<string, number> = {
  concrete: 1,
  metal: 1.35,
  sand: 0.7,
  glass: 0.25,
  hazard: 0.85,
};

/**
 * Share of a blast's centre damage that goes into the map rather than into
 * tanks — the boss's ordnance is sized against armour, and a wall is not
 * armour. Kept as a separate knob from integrity so the two questions stay
 * separate: this one is "how much of a shell goes into the building", and the
 * one above is "how much building there is".
 */
export const DEMOLITION_POWER_SCALE = 0.9;

/** Tall and thin enough to go over sideways rather than sit down. */
export const TOPPLE_RATIO = 1.25;
/** Seconds it takes to fall — long enough to read, short enough to fear. */
export const TOPPLE_TIME = 0.9;
export const TOPPLE_CRUSH_DAMAGE = 520;
export const TOPPLE_CRUSH_IMPULSE = 16;

/**
 * How high the rubble stands. A tank climbs a 1.6 m step, so this is
 * deliberately under it: what a building leaves behind is something you drive
 * over, never something you shelter behind. Rubble that restored cover would
 * make the whole system cosmetic.
 */
export const RUBBLE_HEIGHT = 1.1;

/**
 * Base height above which a prop stands on something rather than on the ground.
 * An elevated prop that is also *flat* — a bridge span, a walkway, a roof — is
 * a deck: it does not leave rubble, it falls away entirely, and whoever was
 * shooting from up there discovers that the floor was a target. That gap is the
 * one genuine hole the demolition can make, and it stays open for the rest of
 * the fight. An elevated prop that is not flat is a parapet or a rooftop block,
 * and it collapses where it stands, on top of whatever is holding it up.
 */
export const ELEVATED_BASE = 1.5;
/**
 * Height-to-footprint ratio below which an elevated prop is a floor. Tight: a
 * 12 × 4 × 12 block sitting on a bank is cover that happens to be up a hill,
 * not a deck, and at a looser ratio it was being deleted outright — and
 * announced as the high ground going with it, which it was standing on.
 */
export const DECK_FLATNESS = 0.25;

/**
 * Blast damage a strike needs before it digs at all — above the main gun's
 * 260, so the Cataclysm does not scar the floor with every shell and a crater
 * always means something heavy landed: a rock, a barrage round, a Quake.
 */
export const CRATER_MIN_POWER = 300;
/**
 * Crater radius per square root of blast damage. Small on purpose, and the
 * first pick was nearly three times this: a Meteor Storm dug fifteen-metre
 * scars, the merge rule joined them, and a screenshot after three minutes
 * showed a tank sitting in the middle of a single black disc the size of the
 * arena. A crater is a mark the ordnance left, not a re-texture of the map.
 */
export const CRATER_RADIUS_PER_POWER = 0.12;
/** Strikes closer together than this deepen one crater instead of adding one. */
export const CRATER_MERGE = 6;
/** And how far a crater can grow by being hit again. */
export const CRATER_GROWTH = 0.25;
export const CRATER_GROWTH_MAX = 4;
export const CRATER_MAX = 40;
/** Extra pathing cost bots pay for crossing churned ground. */
export const CRATER_ROUGHNESS = 1.4;
/** How near the surface a detonation has to be to leave a mark. */
export const CRATER_SURFACE_REACH = 3;

/** Structural damage a ramming Overseer does to whatever it drives through. */
export const RAM_DEMOLITION_POWER = 900;
export const RAM_DEMOLITION_REACH = 5;

/**
 * ---- The squad channel ------------------------------------------------
 *
 * The raid talking to itself.
 *
 * Until now the squad was scenery: four bots that happened to be shooting the
 * same target, with no knowledge that a boss fight was happening around them.
 * They stood in Quake rings. They drove through storms. Most damningly they
 * could not *choose* to break a hunt — the rescue bar filled from passive chip
 * damage or it did not fill at all, which meant the one mechanic in the mode
 * that was written to be answered by the squad was the one mechanic the squad
 * had no way to answer.
 *
 * So the calls below are not chatter with a mechanic attached; they are the
 * mechanic, and the chatter is what makes it legible. Every line a squadmate
 * says is something it is about to *do*, which is the only kind of radio worth
 * having: "moving" means it is moving, "breaking it off you" means four guns
 * are turning round, and the player can hear a rescue coming before the bar
 * shows it.
 */

/**
 * Seconds between any two calls, and between two calls on the same subject.
 * Both were much shorter and the harness counted a line every six seconds
 * across a whole fight — which is not a squad talking, it is a squad
 * narrating, and it buries the Overseer's own warnings in the same six-line
 * feed. At these numbers a fight carries a call every ten to fifteen seconds,
 * which is roughly one per thing that actually happens.
 */
export const CALL_GAP = 3.2;
export const CALL_TOPIC_GAP = 20;

/**
 * How far outside a danger zone a bot wants to be before it stops running.
 * Generous: a squadmate that clears a Quake ring by half a metre and stops has
 * technically obeyed and is still dead.
 */
export const EVACUATE_MARGIN = 8;
/**
 * Seconds left on a zone below which running is pointless — at that point the
 * bot is better off firing than being caught mid-turn. It also stops a squad
 * from spending the entire fight reacting to a wind-up that is about to end.
 */
export const EVACUATE_GIVE_UP = 0.35;

/**
 * How far a squadmate will break off its own fight to answer a hunt. The
 * rescue has to cost something or it is not a decision — a bot that abandons a
 * good firing position from across the map is just a homing missile with a
 * name.
 */
export const RESCUE_REACH = 90;

/**
 * Purge, the Juggernaut's ultimate, vents the reactor: it throws the raid off
 * the hull and patches the boss on the way. The heal is small against a pool
 * this size and clamped to the phase gate like every other heal it has, so it
 * buys the Overseer a few seconds of breathing room rather than a reset — but a
 * raid that lets it charge Purge four times has given away a phase.
 *
 * The fraction itself lives on the hull in `hulls.json`, since that is where
 * the overdrive is defined; this is the health fraction below which the boss
 * will spend a charged Purge purely to heal, with nobody close enough to throw.
 */
export const PURGE_HEAL_AT = 0.55;
