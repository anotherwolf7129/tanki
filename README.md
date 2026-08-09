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
announced, marked on the minimap, dropped from the sky, and contested by the bots. You start with
**15 of every kind** (`PLAYER_SUPPLY_STOCK`), because Smart Cooldowns rather than scarcity are what
stop supplies being spammed, and a stock of three ran dry ten minutes before a battle ended.

**Drones** — one optional escort fitted in the garage, which modifies supplies rather than the hull
or the turret (see below).

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

**Augments** — one optional modification per turret and per hull, three to choose from for every
item in the game, fitted in the garage and remembered per item (see below).

**Seven maps** assembled from a 5 m prop kit: Sandbox, Silence, Kungur, Rio, Polygon, Stadium and
low-gravity Madness. Geometry is original primitives, not ripped assets.

**The AI**, which is where the real design work lives — see below.

Not implemented: the Rugby / Siege / Assault modes, modules, the
crystal economy and purchasing, and audio. The modification tier system is collapsed to a single
tier per item plus a flat multiplier, which the difficulty profile uses as the equipment gap.

## Augments

Every turret and every hull has three augments (`src/data/augments.ts`), and you fit one of each in
the garage. The choice is stored per item, so swapping hulls does not throw away what you had picked
for the one you are coming back to, and the garage card quotes the item *as fitted* — an augment that
changes a number you can see changes it on the card too.

None of them is a straight upgrade. Every augment that adds somewhere takes somewhere else, or costs
you the other two:

- **Vulcan · Ignition** — the headline. Vulcan already punishes you for holding the trigger; Ignition
  makes that worth doing. Once the barrel is genuinely overheated every round sets the target alight,
  and the burn is heavy enough and long enough to finish a tank on its own if you keep firing. It
  also raises the heat ceiling so the gun keeps working deeper into the red — which is the whole
  trade, because everything above 1.0 is cooking you as well. Titan's **Thermal Sink** is the hull
  that can afford it.
- **Shaft · Mobile Scope** — you can drive while scoped, and the charge builds slower for it. The
  augment that changes how a turret is played rather than what its numbers say.
- **Isida · Vampirism** — a third of the damage you do comes back as health.
- **Thunder · Concussion** — the overpressure regularly leaves the target unable to shoot back.
- **Mammoth · Spall Liner** — attackers eat a slice of whatever they deal you.
- **Hunter · Field Repair**, **Ares · Regenerative Plating** — repair themselves once nothing has hit
  them for a few seconds.
- **Hunter · Ram Plate**, **Mammoth · Charger** — driving into someone at speed becomes a real attack.

Mechanically an augment is either *numbers* or *behaviour*, never both smeared across the codebase.
Numbers are folded into a copy of the item's definition before the battle starts, so the whole
simulation reads them for free — a turret whose range an augment extended simply has a longer range,
and the bots' engagement bands move with it without knowing augments exist. Behaviour is a small set
of named traits resolved at the bottom of the damage funnel, which is why a burn rides on whatever
put the damage through — shell, blast or beam tick — rather than on the one firing mode somebody
remembered to wire.

**Bots fit them too.** Each persona names the augments that match how it fights — a Bruiser wants its
Vulcan setting people on fire — and a minority of bots roll something else instead, so a persona
reads as a build the enemy usually runs rather than as a fixed serial number. Whether bots get
augments at all is part of the equipment gap: on Recruit they fight stock and the garage says so.
The Overseer's fittings are authored rather than rolled, because the raid is balanced against that
exact boss.

## Drones

A third garage slot (`src/data/drones.ts`), fitted independently of the hull and turret because a
drone does not modify either of them — it modifies *supplies*, which are the same whatever you are
driving. That is the whole reason it is not a third augment table: an augment is authored per item
and folded into that item's definition before the battle starts, and there is no item here to fold
anything into. The entire system is two fields, and the only place in the simulation that reads them
is `Tank.applySupply`.

**Overcharger** — the one drone that ships. Whatever supply you use lands *twice over*:

| Supply | Stock | Overcharger |
|---|---|---|
| Double Damage | ×2 damage dealt | **×4** |
| Double Armor | ×0.5 damage taken | **×0.25** |
| Speed Boost | ×1.4 speed | **×1.96** |
| Repair Kit | 1,000 instant + 3,000 over 3 s | **doubled** |
| Mine | 1,800 blast | **doubled** |

and it costs you the ability to run more than one of them. The reactor holds a single charge: Double
Armor, Double Damage and Speed Boost lock each other out, and starting one *ends* whichever was
already running rather than being refused — the supply you just spent always does something. Repair
Kit and Mine leave nothing running and are unaffected in either direction. Durations are untouched
throughout: the kit hits harder, it does not last longer. The exclusivity holds for every source of
a buff, including Viking and Dictator's requisition Overdrive, which grants a drone-fitted tank the
last buff it applies rather than all of them.

Stacked against 15 of each supply in the stock loadout, that is a real trade rather than an upgrade:
without a drone you can have all three buffs up at once and spend them freely, and with one you get
a single buff at twice the strength.

Mechanically the strength lives in the status effect's `magnitude`, which now means *how many times
over the effect is applied* — 1 from a supply, 2 from an amplifying drone — and the three buffs
compound it (`2 ** magnitude`, `0.5 ** magnitude`, `1.4 ** magnitude`) rather than each source
special-casing itself. Everything downstream reads the same multipliers it always did, which is why
quadruple damage lifts splash, burn-on-hit and every firing mode without a single one of them
knowing a drone exists. The HUD marks an amplified buff with `×2` on its pill, and names the fitted
drone above the supply tray.

Drones are the player's alone: bots and the Overseer fight with the stock ruleset.

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
- **It is inside that blast radius too, and it knows it.** Everything the Overseer fires can hurt
  the Overseer — it takes a quarter share of its own splash, the same deal its Meteor Storm has
  always given it. So before every trigger pull it traces the barrel line it is *actually* pointing
  down, plus every shell in the fan behind that one, and holds fire if any of them would detonate
  close enough to come back. It does not shoot the wall it has backed against, and it does not
  answer a raider hugging its glacis with a siege round: it backs out to a range its gun works at
  and reaches for a *Quake* instead, which is why getting inside its minimum range is dangerous
  rather than free. When a blast does catch it anyway — someone reversed into the shell, a rock
  landed where it was about to fire — it says so in the kill feed and widens the ring it refuses to
  shoot inside. It shoots once and works the rest out.
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

**It is built to be frightening, not merely difficult.** Everything above makes the Overseer
dangerous, and danger is a number — it gets read off the HUD, answered with a hull choice, and after
two raids it is arithmetic. Fear is a different thing, and it is not made of bigger numbers. Three
mechanics exist purely to supply it, and none of them touches a damage figure:

- **It chooses somebody.** From Siege onward the Overseer periodically stops arbitrating between
  threat scores and simply marks one raider *by name*. While a hunt is running the threat table is
  not consulted at all: it drives at its quarry, aims everything at them, ignores the supply box it
  was about to detour for, and **nothing that raider does moves the gun**. Every other threat in the
  mode is one you can personally answer; this is the one you cannot. The way out is the rest of the
  squad putting enough damage into it to drag its head round, which the whole raid watches fill on a
  rescue bar — so a hunt ends one of three ways, and about six in ten end with the squad coming
  back for you, now that the squad can actually decide to. A phase gate re-arms it, which means the pressure wave that throws the raid off the
  hull is followed, three seconds later, by a name.
- **It goes quiet before it strikes.** The last stretch of every wind-up is silent and motionless —
  the pulsing ring stops, the tracks stop, and the ground marks stay lit. The raid keeps all of the
  information and loses all of the noise. It costs the boss a free shot at a stationary six-tonne
  target, which is the fairest window in the fight, and it buys the only thing that makes an
  incoming ability land in the stomach rather than on the health bar: a wind-up that gets steadily
  louder is one you stop hearing.
- **It is felt before it is seen.** A rumble through the hull and a bleed at the edges of the screen
  that rise with how close the Overseer is *and how fast it is closing*, so the twenty seconds
  between abilities stop looking safe. It does nothing, it cannot be countered, and there is no
  correct response to it — which is the only reason it works.

**And it feeds.** Since nobody runs out of lives, a death used to cost tempo and nothing else, and a
death that costs only tempo is a death nobody dreads. Now the Overseer patches itself with whatever
is left of whoever it just killed, and the bar the entire raid is watching goes *up*. The heal is
deliberately small — under half a percent — and it is clamped to the phase ceiling like every other
heal in the game, so it is something you watch happen rather than something that beats you. The
first draft was five times larger and the harness caught it immediately: the bar welded itself to
the phase ceiling and the raid stopped making progress inside a phase at all.

**And it takes the room apart** (`src/game/demolition.ts`). Every other escalation in the mode
happens to the Overseer — it gets faster, it hits harder, it fans more shells out of the barrel, all
of which a raid answers by playing better. This one happens to the *arena*, it is subtractive, and it
is permanent: the wall you held the first phase behind is not there in the third.

Its ordnance carries integrity damage into whatever it lands near, sized off the prop's own volume
and material, so a glass box goes early and a concrete block takes a storm. What happens next depends
on the shape of the thing. A tall one **topples** — a second of visible lean, announced, with the
ground it is about to land across published to the raid, and anything still under it is crushed. A
wide one **sits down**. Either way what is left is a rubble field 1.1 m high: still something you
bump over, never again something you hide behind, because rubble that restored cover would make the
whole system cosmetic. And an elevated deck does not leave rubble at all — it falls away, which is
the one genuine hole the boss can make, and whoever was shooting off the top of it discovers that the
floor was a target.

Three exemptions keep it a mechanic rather than a way to break the map: the perimeter, the ramps that
connect the map to itself, and anything with a footprint big enough to be *terrain* rather than
cover. That last one is not a nicety — maps are authored from the same 5 m prop kit as the buildings,
so the thing holding up half of Kungur is structurally a 200 × 40 m wall, and the first version of
this was perfectly happy to level it and take the spawns with it.

**Only the Overseer does this.** Your Thunder shell leaves the wall standing. Cover is the raid's
resource and the boss is the only thing that can spend it, so "there is less to hide behind than
there was" is always a sentence about what the boss has done to you. The HUD prints it as
`COVER −n%` next to the loss count, because otherwise it is a loss you only notice by dying in the
open. Craters are the honest half: the arena floor is one collider, so a crater is a scorched,
churned, permanently-marked patch of ground that costs the squad's pathing to cross — not a pit you
fall into.

**And the squad can finally see any of it** (`src/ai/squad.ts`). Until now the raid's bots did not
know a boss fight was happening: they stood in Quake rings, drove through storms, and — the damning
one — could not *choose* to break a hunt, so the rescue bar filled from chip damage or it did not
fill at all. The one mechanic in the mode written to be answered by the squad was the one mechanic
the squad had no way to answer.

So the Overseer now publishes ground it has committed to hitting — the Quake ring, each rock's
impact, the barrage's aim, a building's fall line — to a shared channel, and two branches sit at the
top of the raid squad's behaviour tree: **clear the ring**, above self-preservation because the
ground resolving in one second beats the health you have left, and **break the mark**, which turns
four guns round onto the boss when it fixates on somebody. Nothing on that channel is knowledge you
do not have; every zone on it already has a ring drawn on the floor or a warning in the feed. The
squad is not being told things — it is being allowed to read its own HUD.

The radio is how that becomes legible, and every line is something the speaker is *about to do*:
`Coldiron: breaking it off you — hit the deck with me` means four guns are already turning. It is
rate-limited twice over, globally and per topic, and there is deliberately no line for dying —
the kill feed already prints every loss, and measured, that one topic was most of the channel's
traffic. Squad traffic is green in the feed so it never competes with the Overseer's own warnings.

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
- **Behaviour tree** (`src/ai/bot.ts`) ticked at 10 Hz over a blackboard: clear the danger zone →
  break the mark → survive → mode objective → contest pickup → engage → patrol. Steering, aiming and
  trigger discipline run every frame. The first two branches read the raid's squad channel and are
  inert in every other mode, where nothing supplies one.
- **Navigation** (`src/ai/navgrid.ts`) — the navgrid is sampled straight out of the physics world,
  one downward ray per 3 m cell. Neighbours connect only when the step between them is small enough
  for a tank to climb, which handles ramps, bridges and raised platforms without authoring a separate
  navmesh, and stays correct when map props change — including when a boss changes them mid-battle,
  since a demolished building re-samples the patch it stood on rather than invalidating the grid.
- **Aim model** — error shrinks the longer a bot holds a target and resets when line of sight breaks.
  That single mechanic does most of the work of making bots feel intelligent, and it is what rewards
  the player for breaking contact.
- **Personas** (`src/ai/personas.ts`) — Rusher, Sniper, Support, Bruiser, Flanker and Objective, each
  with its own loadout, aggression, standoff distance and reaction scaling. A roster is mixed so a
  team never reads as eight copies of one bot.
- **Team blackboard** — deliberately shallow: target calls and a claim system so two bots don't race
  for the same box. Emergent coordination reads better than scripted squad play, and in a line battle
  that is all it needs to do. The **squad channel** (`src/ai/squad.ts`) is the boss fight's exception,
  because everything dangerous in a raid is a shared problem on a timer that no bot can discover by
  looking at its own perception.

## Making the player advantaged

Layered per the spec, in `src/data/difficulty.ts`. The design rule constrains every value: bots are
never made weak or passive, only *slow* and *imprecise*.

1. **Legible** — equipment gap (hull and turret tier multipliers, shown explicitly in the garage),
   supply economy (15 of each at spawn against a bot's one or two, and drones are yours alone),
   overdrive charge rate.
2. **Perceptual** — reaction delay, an aim-error floor bots never converge past, peripheral
   blindness so flanking always works, and single-target focus so you can rotate between bots.
3. **Soft assists** — turret magnetism inside a small screen cone, damage rounded in the player's
   favour in both directions, last-hit protection on a 60-second cooldown (never surfaced in the UI),
   and asymmetric spawn protection.
4. **Dynamic** — a rolling 90-second K/D window nudges bot reaction and aim, capped so a genuinely
   good player can still reach total dominance.

Four presets ship — Recruit, Standard, Veteran, Nightmare — and every layer above shrinks as you
climb, down to nothing at the top: on Nightmare the bots react in 120 ms, hold their aim and take no
handicap of any kind.

The equipment gap is the exception, and it never closes. On every preset your hull and turret are
tiered above anything else on the field, squadmates included, because the tank you drive is meant to
read as the best one in the battle — difficulty decides how much of an edge that is, not whether
there is one. The single thing that outclasses it is the Overseer, whose health pool is authored for
the size of the raid squad and sits outside the tier table entirely. Every knob is visible in the
garage's "Your edge" panel.

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
  data/      turrets.json, hulls.json, augments, drones, maps/, supplies, modes, difficulty, raid
  ai/        navgrid, perception, behaviour tree, personas, team board, boss, squad channel
  render/    scene, procedural textures, materials, tank meshes, effects, camera, HUD
  modes/     dm, tdm, ctf, cp, boss raid
  game/      battle orchestration, overdrives, arena demolition
  ui/        garage and battle setup
tools/
  validate-maps.mjs
  raid-smoke.mjs
  augment-smoke.mjs
  turret-dps.mjs
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
in its supply rack, how far it travelled, how much of the time the player was in its rear arc, how
much of the map's cover was still standing at the end, and how much the squad said. The stand-in
cannot aim, so read its runs as "what the bot squad alone manages" — the human share of the damage is
the whole premise of the mode and the harness does not model it. Run it several times — bot pathing
makes single runs noisy, and it is the spread that tells you whether the mode is tuned.

It is what caught the balance bugs that mattered: a repair rate that scaled off the boss's own pool
and so out-healed the entire squad, squadmates whose guns could not reach the range the boss holds,
a rescue threshold nobody ever reached, structural integrity so high that four hundred simulated
seconds brought down between zero and two buildings, and a squad radio that was saying something
every six seconds — most of it announcing deaths the kill feed had already printed.

## Augment harness

Augments reach into every other system — they rewrite turret and hull definitions before the
simulation sees them, and a bad multiplier does not throw. It produces a clip of zero shells, a NaN
reload or a cone with no angle, and the battle quietly stops making sense somewhere downstream.

```bash
npm run augment-smoke              # every augment, 1 s of battle each
node tools/augment-smoke.mjs 3     # 3 s each
```

fits every augment in the table to a real battle in turn, holds the trigger down, and reports
anything that comes back non-finite, non-positive or missing. It also pins the two things about
Ignition worth a regression test rather than a play test: that it does nothing at all until the
barrel is overheated, and that once it is, the burn alone takes a serious bite out of a tank.

## Drone harness

What a drone does is invisible from outside the damage funnel. One that quietly failed to amplify,
or whose exclusivity cancelled a buff it had no business touching, looks exactly like one that
works — you would notice as a target dying slightly slower than it should have, ten minutes into a
battle.

```bash
npm run drone-smoke
```

fits every drone in the table to a live battle, applies each supply in turn and reads the resulting
multipliers straight out of the status set: that Double Damage is ×4 and not ×2, that Double Armor
leaves a quarter, that an exclusive drone has ended the buff it replaced and a non-exclusive one has
not, and that none of it reaches the physics as a NaN. It checks the stock ruleset in the same run —
three buffs stacking at ×2 and ×0.5 with no drone fitted — and that a battle starts you with a full
stock of every supply.

## Turret damage harness

A turret's `damage` field means something different in every firing mode — a whole shell for Magnum,
a tenth of a second of contact for Firebird, one pellet of eight for Hammer — so the numbers in
`turrets.json` are not comparable to each other and never were. The only figure that compares is
damage actually put into a tank per second of trigger, with the reload, clip, fuel drain, heat
ceiling, spin-up, chain falloff and range band all in play.

```bash
npm run turret-dps                 # every turret, 12 s each, at its own working range
node tools/turret-dps.mjs 20       # longer, for the slow-cycling guns
node tools/turret-dps.mjs 20 veteran
```

puts every gun on a firing range against a pinned target that cannot shoot back, drive off or die,
holds the trigger — releasing it at the top of the charge for the two guns that fire that way — and
prints the result sorted. Figures are for the player's own tank, so they include the difficulty
profile's turret tier: the gun as you actually drive it rather than as authored. It fails if any gun
puts out nothing at all, which is the cheap way to catch a firing mode that silently stopped working.

It is what caught the close-range guns landing for a third of the field's output while reading fine
in the data, and the tick-based turrets being the only ones in the game a Double Damage box did
nothing for.

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
