import "server-only";
import { cookies } from "next/headers";
import { sql } from "drizzle-orm";
import { db } from "@/db/client";
import * as s from "@/db/schema";
import { BASE_CURRENCY, ORIGINAL, type Fx } from "./fx";

/** The cookie the currency picker sets. */
export const FX_COOKIE = "currency";

/** European Central Bank reference rates; no key, and only the currency codes are sent. */
const SOURCE = "https://api.frankfurter.dev/v1/latest";
const STALE_SECONDS = 12 * 60 * 60;

function heldCurrencies(): string[] {
  const rows = db.selectDistinct({ c: s.accounts.currency }).from(s.accounts).all().map((r) => r.c);
  return [BASE_CURRENCY, ...rows.filter((c) => c !== BASE_CURRENCY).sort()];
}

function cached() {
  return db.select().from(s.fxRates).all();
}

/** Fetch the latest rates and cache them; on any failure keep what is cached. */
async function refresh(currencies: string[]): Promise<void> {
  const others = currencies.filter((c) => c !== BASE_CURRENCY);
  if (!others.length) return;
  try {
    const res = await fetch(`${SOURCE}?base=${BASE_CURRENCY}&symbols=${others.join(",")}`, {
      signal: AbortSignal.timeout(4000),
      cache: "no-store",
    });
    if (!res.ok) return;
    const body = (await res.json()) as { date?: string; rates?: Record<string, number> };
    for (const [currency, perBase] of Object.entries(body.rates ?? {})) {
      if (!(perBase > 0) || !body.date) continue;
      db.insert(s.fxRates)
        .values({ currency, perBase, asOf: body.date })
        .onConflictDoUpdate({
          target: s.fxRates.currency,
          set: { perBase, asOf: body.date, fetchedAt: sql`(unixepoch())` },
        })
        .run();
    }
  } catch {
    // Offline, or the source is down: the last rate on file still serves.
  }
}

/**
 * The view the user picked, with the rates to show it. Rates are fetched only
 * when a currency view is chosen and the cached ones are missing or more than
 * twelve hours old; with none to be had, the view falls back to original.
 */
export async function loadFx(): Promise<Fx> {
  const wanted = (await cookies()).get(FX_COOKIE)?.value ?? ORIGINAL;
  const currencies = heldCurrencies();
  const mode = currencies.includes(wanted) ? wanted : ORIGINAL;

  let rows = cached();
  if (mode !== ORIGINAL) {
    const now = Date.now() / 1000;
    const stale = currencies.some((c) => {
      if (c === BASE_CURRENCY) return false;
      const r = rows.find((x) => x.currency === c);
      return !r || now - r.fetchedAt > STALE_SECONDS;
    });
    if (stale) {
      await refresh(currencies);
      rows = cached();
    }
  }

  const perBase: Record<string, number> = { [BASE_CURRENCY]: 1 };
  for (const r of rows) perBase[r.currency] = r.perBase;
  const complete = currencies.every((c) => perBase[c]);
  const asOf = rows.filter((r) => currencies.includes(r.currency)).map((r) => r.asOf).sort()[0] ?? null;

  if (mode !== ORIGINAL && !complete) {
    return { mode: ORIGINAL, perBase, asOf, currencies, unavailable: mode };
  }
  return { mode, perBase, asOf, currencies };
}
