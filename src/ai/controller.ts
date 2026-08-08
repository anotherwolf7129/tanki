/**
 * What the battle loop needs from anything driving a tank. Line bots
 * (`BotController`) and the raid boss (`BossController`) are quite different
 * animals internally — one runs a persona-weighted behaviour tree, the other a
 * threat table and an ability rotation — so the battle talks to both through
 * this instead of through either class.
 */
export interface AiController {
  /** Shown next to the name on the scoreboard. */
  readonly persona: { readonly displayName: string };
  /** Set by the controller, consumed and cleared by the battle. */
  pendingOverdrive: boolean;
  update(dt: number, now: number): void;
  onDeath(): void;
  /**
   * Called by the tank each time its main gun goes off. Only the raid boss uses
   * it, to fan the rest of a salvo out around the shell the weapon just fired.
   */
  onFired?(): void;
}
