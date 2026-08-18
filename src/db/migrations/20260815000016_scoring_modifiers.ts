import type { Knex } from "knex";

/**
 * Two independent scoring knobs, both previously hardcoded:
 *
 * - DM Maybe/If Needed modifiers: extra weight (positive or negative)
 *   applied ONLY to the DM's own contribution when their raw response is
 *   "Maybe" (weight 1) or "If Needed" (weight 2). Defaults to 0, which
 *   reproduces the previous behavior exactly (DM's contribution == raw
 *   weight, same as every other member). E.g. setting the Maybe modifier
 *   to -0.5 turns a DM's "Maybe" response from 1pt into 0.5pt.
 * - Late/early penalty: previously a flat 0.5 deducted per active
 *   joining-late/dropping-early flag. Now configurable per campaign;
 *   default of 0.5 reproduces the previous behavior exactly.
 *
 * Both are floats (not decimals) so mysql2 hands them back as JS numbers
 * rather than strings, matching how the scoring engine already treats
 * weights and deductions as plain numbers throughout.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("campaigns", (t) => {
    t.float("dm_maybe_modifier").notNullable().defaultTo(0);
    t.float("dm_if_needed_modifier").notNullable().defaultTo(0);
    t.float("late_early_penalty").notNullable().defaultTo(0.5);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("campaigns", (t) => {
    t.dropColumn("dm_maybe_modifier");
    t.dropColumn("dm_if_needed_modifier");
    t.dropColumn("late_early_penalty");
  });
}
