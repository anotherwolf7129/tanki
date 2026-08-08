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
| `−` `=` | Camera boom out / in |
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

**All 17 turrets**, data-driven from `src/data/turrets.json`, covering every firing archetype:
cone (Firebird, Freeze), locked beam (Isida, Terminator), chain (Tesla), clip and pellets (Hammer),
sustained (Twins), bouncing (Ricochet), critical-hit single shot (Smoky), guided volley (Striker),
overheating minigun (Vulcan), splash (Thunder, and the boss's siege Cataclysm), charged piercing
hitscan (Railgun), ballistic with a landing indicator (Magnum), dual mode (Gauss), and the scoped
charge sniper (Shaft).

**All 11 hulls** with their Overdrives implemented as real world effects rather than stat buffs —
N2 bomb, battlefield sonar, blast jump, EMP, freezing icicle, supercharge, requisition, arc pulse,
protective dome, contact-kill rampage, and the Juggernaut's purge.

**Status effects** (burning, freezing, EMP, stun, AP, supercharge and the supply buffs) as a
stackable component, with Firebird thawing allies, Freeze extinguishing burn, and Juggernaut immune.

**Supplies** on the 2016-rebalance ruleset: 40-second durations, a 10-second cross-cooldown rather
than a lockout, Mine and Repair Kit exempt from each other, and box pickups that bypass Smart
Cooldowns entirely — which is what makes drop-zone control worth fighting over. Plus the Gold Box,
announced, marked on the minimap, dropped from the sky, and contested by the bots.

**Five modes**: Deathmatch, Team Deathmatch, Capture the Flag (with the wiki's pickup/transfer/
delivery scoring, banked and only paid out on delivery), Control Points, and **Boss Raid** — you and
a squad against one Overseer, described in its own section below.

Every mode except the raid races to a number as well as running a clock, and the setup screen sets
that number in the mode's own unit: kills for Deathmatch (one player's own total), team kills for
Team Deathmatch, deliveries for Capture the Flag, accrued score for Control Points. Each mode
remembers its own value, because they do not fill at the same rate — 30 is a long Deathmatch and a
three-minute Team Deathmatch, which is why one shared limit ended a TDM before it had started. Slide
the limit to zero and only the clock ends the battle. The HUD prints the target next to the score.

**Area damage** is data-driven from a `splash` block in `turrets.json`, and any turret that declares
one delivers it however it fires — shell, bounced shell, pellet, missile or hitscan beam. The blast
falls off linearly from `damageMax` at the centre to `damageMin` at the rim, is blocked by walls but
not by tanks, hurts the shooter when the turret sets `selfDamage`, and scales with the same
multipliers as a direct hit, so Double Damage lifts the whole shell rather than half of it. Thunder,
Magnum, Striker, Cataclysm and the Gauss super shot are the turrets that carry one; the garage card
shows the radius.

**Seven maps** assembled from a 5 m prop kit: Sandbox, Silence, Kungur, Rio, Polygon, Stadium and
low-gravity Madness. Geometry is original primitives, not ripped assets.

**The AI**, which is where the real design work lives — see below.

Not implemented: the Rugby / Siege / Assault modes, modules, drones, augments, the
crystal economy and purchasing, and audio. The modification tier system is collapsed to a single
tier per item plus a flat multiplier, which the difficulty profile uses as the equipment gap.

## Boss Raid

One Overseer against you and a squad of allied bots. It is the one place in the game where an
opponent is *not* slow and imprecise — but it earns that by being a different kind of opponent
rather than a line bot with the handicaps switched off.

**You are the raid's damage.** Your shots land on the boss for ×2.00; a squadmate's for ×0.45. A
direct hit on its engine deck — the rear arc — is worth ×1.60 again. Every one of those numbers is
printed in the garage next to the standard "Your edge" panel, because an advantage you can read is
an advantage that feels earned.

**Which is exactly what puts you in front of the gun.** The Overseer picks its target from a
decaying table of who has actually hurt it, so out-damaging four squadmates drags its attention onto
you. The HUD's threat meter is your share of the current leader's, and it turns red and says so when
you are the one it is looking at. Trading that attention with the squad — pushing damage, backing
off, working round to the deck while it is busy elsewhere — is the mode.

**It is genuinely smarter, in ways you can see** (`src/ai/boss.ts`):

- **All-round sensors.** Peripheral blindness is what makes flanking a line bot work, and the boss
  does not have it. You flank it by taking its attention elsewhere first, not by driving wide.
- **It aims at groups.** With a nine-metre blast it puts the shell between two raiders rather than
  on one, and leads a lone target properly.
- **It protects its own weak point.** When it picks ground it prefers a wall behind its engine deck,
  refuses positions where the raid has it ringed, and turns its glacis toward whoever it is fighting
  when it stops. Reaching the deck is a manoeuvre you have to earn.
- **It spends abilities on reasons.** *Quake* when raiders stack on it, *Siege Barrage* — a lobbed
  salvo that does not care about your cover — when they hide or bunch up at range, a *Meteor Storm*
  when hiding is all anybody is doing, *Overcharge* when someone is isolated, and *Purge* to throw
  the raid off it. Each has a wind-up, a kill-feed warning and a pulsing ring at the hull, so every
  one of them is something you could have avoided.
- **It brings the sky down.** The *Meteor Storm* stops fighting the raid and starts shelling the
  ground the raid is standing on: four to thirteen rocks depending on the phase, one every third of
  a second, walking across wherever it last accounted for anybody. Each one comes in off the top of
  the sky as a real projectile with a ring closing on the ground for exactly its flight time, and
  each one kills a light hull outright — cover overhead is the only thing that stops it, and open
  ground is where its main gun lives. **It does not aim them around itself.** The Overseer takes a
  quarter of its own bombardment, so a raid that holds its ground under a storm is a raid making the
  boss help kill it. That trade — the fastest damage in the mode against very nearly the fastest way
  to lose the squad — is the best thirty seconds of the fight.
- **It heals like a player.** It carries repair kits and spends them the way you do — and the
  over-time half is interrupted by damage exactly as yours is, so a boss that has just cracked one
  open is a boss you can punish for it. When it runs out it drives to the boxes on the floor, which
  is the one reliable way to pull it off a position it likes. *Purge* patches it as it throws you.
  None of it can take the Overseer back through a phase gate — every heal in the game funnels
  through one clamp in `Battle.heal`.
- **It will not be waited out.** Disengage completely — nobody in sight and nobody hurting it — and
  it repairs, six times faster while the whole raid is dead at once.

**Its shells are sized against armour, not against tanks.** Everything it fires lands for ×1.20, and
×1.28 again on a light hull: one direct hit takes a Wasp to a sliver, and you are allowed exactly one
mistake. Heavy hulls take ×0.86 of it, which is the whole reason to bring one. It is the only place
in the game where hull class changes how much damage you *take*.

**Phases change tempo, volume, speed and force — never armour.** At 66%, 33% and 15% its cooldowns
shorten, its main gun goes from one shell a pull to two, three, then four fanned out either side of
where you were about to dodge, and — the two you feel in your hands rather than read off the HUD —
its hull speed climbs to ×1.85 and everything it does to you lands for ×1.75. From Siege onward it
stops going *around* raiders and simply drives through them, and a six-tonne hull arriving at speed
does real damage. Crossing a gate announces itself and throws the raid off the hull with a pressure
wave, and the last one turns the Overseer berserk: permanently supercharged, no longer managing
range, driving at whoever it wants.

**And berserk is a slope, not a switch.** Inside that last phase it keeps accelerating as the bar
empties — speed, damage and reload all ramp again from 15% down to zero, up to ×2.30 speed and
×2.25 damage in the seconds before it dies. Both multipliers are printed live next to the phase
name on the boss bar, because a boss that is suddenly outrunning you should be one you can see has
been given the speed, not one you suspect of cheating.

**Reinforcements are unlimited.** Nobody is ever benched — the squad always comes back. What a death
costs is *time*: the wait climbs from four seconds toward twelve as the raid takes losses, and every
one of those seconds is a second the Overseer spends repairing. The old shared ticket pool failed in
both directions — a raid that was winning never noticed it, and a raid that was losing was ended by
an accountant rather than by the boss. Now the only two things that can beat you are the clock and a
boss healing faster than you hurt it.

Squadmates run full-tier hulls rather than the bot equipment gap, and a roster picked for a boss
fight — a body to hold its attention, a healer, then reach. A Rusher's fifteen-metre flamethrower
can never touch something that holds forty metres, so the raid roster does not field one.

Everything numeric lives in `src/data/raid.ts` and is meant to be tuned.

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

## Presentation

No image or model assets ship with the project — every surface is a canvas texture drawn from code in
`src/render/textures.ts`, and every shape is a three.js primitive.

**Tank construction** (`src/render/tankmesh.ts`). A hull is authored as ~150 primitives: a tub with a
sloped glacis, a chamfered fighting compartment, a louvred engine deck with exhaust stacks, a closed
track loop with sprockets, idlers, road wheels and return rollers, then hatches, optics, handrails,
tow shackles, stowage bins and spare track links. The turret gets a mantlet, cupola, vision-block
ring, smoke launchers and a rear basket; each firing archetype gets its own gun, from a rifled barrel
with a bore evacuator to a six-tube minigun cluster to a railgun's twin rails.

Those pieces are transformed into place and then **merged into one geometry per material bucket**, so
a tank costs about ten draw calls rather than a hundred and fifty. The merged result is cached by
hull, turret and role, which means a twelve-bot battle uploads each silhouette exactly once.
Silhouette rules vary by hull class — wheel count, hull taper, deck height, turret facets — so a
Mammoth reads as a Mammoth at distance.

**Reading the battlefield.** Barrels are modelled to exactly the distance shots leave from
(`barrelReach` in `src/data/index.ts` is the single source of truth), so muzzle flashes sit on the end
of the gun. Tracks scroll with ground speed, the gun recoils in its mantlet on every shot, and a hull
below a third health trails engine fire and a smoke column — which doubles as target-priority
information for both sides.

**Paint and protection.** Team paint is one greyscale plate sheet tinted per side, with disruptive
camo for bots. The player's tank is deliberately the odd one out: a hand-painted two-tone scheme with
chevroned identification flashes, a bolt-on protection package — reactive armour bricks across the
glacis and turret cheeks, spaced slat armour outboard of the skirts, a slat cage over the stowage
basket — a commander's aerial and pennant, and a faint ground ring in its accent colour. The gap the
difficulty profile grants you in the stat block is something you can see on the model.

## Layout

```
src/
  core/      loop helpers, input, math
  physics/   cannon-es world, collision layers, vehicle controller
  entities/  tank, weapon, projectile, pickup, status
  data/      turrets.json, hulls.json, maps/, supplies, modes, difficulty, raid
  ai/        navgrid, perception, behaviour tree, personas, team board, boss
  render/    scene, procedural textures, materials, tank meshes, effects, camera, HUD
  modes/     dm, tdm, ctf, cp, boss raid
  game/      battle orchestration, overdrives
  ui/        garage and battle setup
tools/
  validate-maps.mjs
  raid-smoke.mjs
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

## Raid balance harness

Raid balance is not eyeballable — the interesting numbers only exist in aggregate.

```bash
npm run raid-smoke                 # kungur, 400 simulated seconds
node tools/raid-smoke.mjs silence  # a different map
```

builds, serves, starts a raid in a real browser and fast-forwards the simulation far faster than
real time, driving a stand-in player, then reports how long the fight lasted, how many losses the
squad took and what a death costs by the end, which abilities actually fired, what the boss had left
in its supply rack, how far it travelled, and how much of the time the player was in its rear arc.
The stand-in cannot aim, so read its runs as "what the bot squad alone manages" — the human share of
the damage is the whole premise of the mode and the harness does not model it. Run it several times — bot pathing makes single runs
noisy, and it is the spread that tells you whether the mode is tuned. It is what caught the two
balance bugs that mattered: a repair rate that scaled off the boss's own pool and so out-healed the
entire squad, and squadmates whose guns could not reach the range the boss holds.

## Balance figures

Numeric values in `turrets.json` and `hulls.json` are tuned starting points designed to reproduce
the *feel* of each weapon, not official game data — the reference spec is explicit that official
numbers aren't published in machine-readable form. Treat them as knobs. The parameter *names* follow
the wiki verbatim so the tables read the way the documentation does.

## Legal note

Game mechanics, stat systems and mode rules are not copyrightable. Names, logos, models, textures
and map art are. Everything here is original geometry built from primitives, and the turret and hull
names are the only borrowed strings — a rename is a find-and-replace in two JSON files. Every texture
in the game is drawn procedurally at load time; no image files are shipped or fetched.
