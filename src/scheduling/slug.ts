import { db } from "../db/index.js";

function baseSlug(name: string): string {
  const s = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return s || "campaign";
}

/** Generates a unique slug for a new campaign, appending -2, -3, ... on collision. */
export async function generateUniqueSlug(name: string): Promise<string> {
  const base = baseSlug(name);
  let slug = base;
  let n = 2;
  // Low-traffic, low-contention table — a simple existence-check loop is fine here.
  while (await db()("campaigns").where({ slug }).first()) {
    slug = `${base}-${n}`;
    n++;
  }
  return slug;
}
