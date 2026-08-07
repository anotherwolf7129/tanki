# Tank Arena

A browser 3D tank arena shooter built to the *Tank Arena Clone — Design Reference Spec*. You are
the only human on the field; every other combatant is AI, and the difficulty layer is tuned so that
you hold a decisive but deniable advantage.

```bash
npm install
npm run dev          # http://localhost:5173
```

`npm run build` type-checks and bundles. `npm run validate-maps` lints every map (see below).

## Controls

The game is keyboard-only. There is no mouse input and no pointer capture.

| Input | Action |
|---|---|
| `↑` `↓` (or `W` `S`) | Drive forward / reverse |
| `←` `→` (or `A` `D`) | Steer the hull |
| `Z` `X` | Slew the turret left / right |
| `C` | Snap the turret back to the hull's heading |
| `Space` | Fire. Hold and release on Shaft and Gauss (see below) |
| `Q` | Overdrive |
| `1`–`5` | Repair Kit / Double Armor / Double Damage / Speed Boost / Mine |
| `R` | Flip an overturned hull |
| `V` | Toggle first person |
| `−` `=` | Camera boom in / out |
| `K` (hold 5 s) | Self destruct |
| `Tab` | Scoreboard |
| `Esc` | Garage / battle setup |

### Aiming

You only aim left and right. Elevation is resolved for you: once the barrel is lined up on an enemy
horizontally, auto-aim solves the angle that actually connects — a straight line for flat-shooting
guns, a real ballistic arc for Magnum — and the target is bracketed on screen with its name and
health so the lock is visible rather than something you infer from where your shell landed.

A turret can only lock what it can physically point at. Every turret declares an elevation envelope
(`pitchUpDeg` / `pitchDownDeg` in `turrets.json`), so a rigid Railgun (16°/10°) cannot lock the tank
on the roof directly above it, while a Magnum mortar (65°/8°) happily lobs over the wall in between.
The lock cone is a fixed miss distance rather than a fixed angle, so "lined up" means the same thing
at 10 m and at 150 m.

### Charged shots

`Space` fires everything. Turrets with a charge behave as hold-and-release:

- **Shaft** — holding the trigger scopes in and winds the charge up to 3 s; releasing un-scopes and
  fires, scaling from 220 to 700 damage with how long you held.
- **Gauss** — tap for the 130-damage light shot, or hold to the top of the 0.9 s charge and release
  for the 420-damage super shot with splash. The reticle ring turns green and reads `RELEASE` when
  the heavy shot is armed.
- **Railgun** — holds and auto-fires at the top of its charge, as before; the charge is committed
  once started.

## What's implemented

**Physics and movement.** Rigid-body hulls with independently rotating turrets, impact force applied
to the target and recoil applied to the shooter as separate impulse channels, damage falloff between
`rangeMaxDamage` and `rangeMinDamage`, tanks that flip and self-right after three seconds, and
raycast-suspension hover hulls that float over terrain. One standard prop is 5 m, as the spec fixes.

**All 16 turrets**, data-driven from `src/data/turrets.json`, covering every firing archetype:
cone (Firebird, Freeze), locked beam (Isida, Terminator), chain (Tesla), clip and pellets (Hammer),
sustained (Twins), bouncing (Ricochet), critical-hit single shot (Smoky), guided volley (Striker),
overheating minigun (Vulcan), splash (Thunder), charged piercing hitscan (Railgun), ballistic with a
landing indicator (Magnum), dual mode (Gauss), and the scoped charge sniper (Shaft).

**All 11 hulls** with their Overdrives implemented as real world effects rather than stat buffs —
N2 bomb, battlefield sonar, blast jump, EMP, freezing icicle, supercharge, requisition, arc pulse,
protective dome, contact-kill rampage, and the Juggernaut's purge.

**Status effects** (burning, freezing, EMP, stun, AP, supercharge and the supply buffs) as a
stackable component, with Firebird thawing allies, Freeze extinguishing burn, and Juggernaut immune.

**Supplies** on the 2016-rebalance ruleset: 40-second durations, a 10-second cross-cooldown rather
than a lockout, Mine and Repair Kit exempt from each other, and box pickups that bypass Smart
Cooldowns entirely — which is what makes drop-zone control worth fighting over. Plus the Gold Box,
announced, marked on the minimap, dropped from the sky, and contested by the bots.

**Four modes**: Deathmatch, Team Deathmatch, Capture the Flag (with the wiki's pickup/transfer/
delivery scoring, banked and only paid out on delivery) and Control Points.

**Seven maps** assembled from a 5 m prop kit: Sandbox, Silence, Kungur, Rio, Polygon, Stadium and
low-gravity Madness. Geometry is original primitives, not ripped assets.

**The AI**, which is where the real design work lives — see below.

Not implemented: the Rugby / Juggernaut / Siege / Assault modes, modules, drones, augments, the
crystal economy and purchasing, and audio. The modification tier system is collapsed to a single
tier per item plus a flat multiplier, which the difficulty profile uses as the equipment gap.

## The AI

Bots are the same `Tank` class as the player. They differ only in having a `BotController` attached
and a different difficulty profile feeding their stats.

- **Perception** (`src/ai/perception.ts`) — bots never read world state directly. Everything arrives
  through a sensor with a field of view, a view distance, a reaction delay, and a memory duration.
  Difficulty is tuned here rather than by nerfing aim after the fact.
- **Behaviour tree** (`src/ai/bot.ts`) ticked at 10 Hz over a blackboard: survive → mode objective →
  contest pickup → engage → patrol. Steering, aiming and trigger discipline run every frame.
- **Navigation** (`src/ai/navgrid.ts`) — the navgrid is sampled straight out of the physics world,
  one downward ray per 3 m cell. Neighbours connect only when the step between them is small enough
  for a tank to climb, which handles ramps, bridges and raised platforms without authoring a separate
  navmesh, and stays correct when map props change.
- **Aim model** — error shrinks the longer a bot holds a target and resets when line of sight breaks.
  That single mechanic does most of the work of making bots feel intelligent, and it is what rewards
  the player for breaking contact.
- **Personas** (`src/ai/personas.ts`) — Rusher, Sniper, Support, Bruiser, Flanker and Objective, each
  with its own loadout, aggression, standoff distance and reaction scaling. A roster is mixed so a
  team never reads as eight copies of one bot.
- **Team blackboard** — deliberately shallow: target calls and a claim system so two bots don't race
  for the same box.

## Making the player advantaged

Layered per the spec, in `src/data/difficulty.ts`. The design rule constrains every value: bots are
never made weak or passive, only *slow* and *imprecise*.

1. **Legible** — equipment gap (hull and turret tier multipliers, shown explicitly in the garage),
   supply economy, overdrive charge rate.
2. **Perceptual** — reaction delay, an aim-error floor bots never converge past, peripheral
   blindness so flanking always works, and single-target focus so you can rotate between bots.
3. **Soft assists** — turret magnetism inside a small screen cone, damage rounded in the player's
   favour in both directions, last-hit protection on a 60-second cooldown (never surfaced in the UI),
   and asymmetric spawn protection.
4. **Dynamic** — a rolling 90-second K/D window nudges bot reaction and aim, capped so a genuinely
   good player can still reach total dominance.

Four presets ship — Recruit, Standard, Veteran, Nightmare — with the advantage shrinking to zero at
the top. Every knob is visible in the garage's "Your edge" panel.

## Layout

```
src/
  core/      loop helpers, input, math
  physics/   cannon-es world, collision layers, vehicle controller
  entities/  tank, weapon, projectile, pickup, status
  data/      turrets.json, hulls.json, maps/, supplies, modes, difficulty
  ai/        navgrid, perception, behaviour tree, personas, team board
  render/    scene, materials, tank meshes, effects, camera, HUD
  modes/     dm, tdm, ctf, cp
  game/      battle orchestration, overdrives
  ui/        garage and battle setup
tools/
  validate-maps.mjs
```

## Map validation

Maps are authored in TypeScript from a prop kit rather than modelled, so the failure modes are
arithmetic: an objective declared at `y: 0` that actually sits on a 10 m platform, a spawn buried
inside a prop, a ramp too steep for a heavy hull, a flag with no route to it.

```bash
npm run validate-maps
```

builds the app, serves it, and runs the checks in a real browser against the same physics world and
navgrid the game uses. It verifies that every spawn, flag, control point and supply zone sits on a
drivable surface at its declared height, and that all of them are mutually reachable.

## Balance figures

Numeric values in `turrets.json` and `hulls.json` are tuned starting points designed to reproduce
the *feel* of each weapon, not official game data — the reference spec is explicit that official
numbers aren't published in machine-readable form. Treat them as knobs. The parameter *names* follow
the wiki verbatim so the tables read the way the documentation does.

## Legal note

Game mechanics, stat systems and mode rules are not copyrightable. Names, logos, models, textures
and map art are. Everything here is original geometry built from primitives, and the turret and hull
names are the only borrowed strings — a rename is a find-and-replace in two JSON files.
