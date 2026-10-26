import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import path from "node:path";
import * as schema from "@/db/schema";
import type { Fx } from "@/lib/fx";

// Runs on the throwaway database tests/setup.ts points FINANCE_DB at. Synthetic data only.
let conn: Database.Database;
let actions: typeof import("@/lib/actions");
let queries: typeof import("@/lib/queries");
const inSgd: Fx = { mode: "SGD", perBase: { SGD: 1, USD: 0.5 }, asOf: "2000-01-01", currencies: ["SGD", "USD"] };
const base = { assetClass: "stocks" as const, costCents: null, asOf: "2000-01-01" };

beforeAll(async () => {
  conn = new Database(process.env.FINANCE_DB!);
  migrate(drizzle(conn, { schema }), { migrationsFolder: path.join(process.cwd(), "drizzle") });
  actions = await import("@/lib/actions");
  queries = await import("@/lib/queries");
});

afterAll(() => conn.close());

describe("portfolio", () => {
  it("splits by source and class in one currency", async () => {
    await actions.createHolding({ ...base, name: "ACME FUND", source: "Broker A", currency: "USD", valueCents: 50_000, costCents: 40_000 });
    await actions.createHolding({ ...base, name: "ACME CO", source: "Broker A", currency: "SGD", valueCents: 50_000 });
    await actions.createHolding({ ...base, name: "Bar", source: "Vault", assetClass: "gold", currency: "SGD", valueCents: 100_000 });

    const p = queries.portfolio(inSgd);
    // US$500 at 0.5 USD per SGD is S$1,000.
    expect(p.totalCents).toBe(250_000);
    expect(p.bySource).toEqual([
      { name: "Broker A", totalCents: 150_000, count: 2, share: 0.6 },
      { name: "Vault", totalCents: 100_000, count: 1, share: 0.4 },
    ]);
    expect(p.byClass.map((c) => c.name)).toEqual(["stocks", "gold"]);
    // Gain only over the holdings with a cost: S$1,000 against S$800.
    expect(p.costCents).toBe(80_000);
    expect(p.costedValueCents).toBe(100_000);
  });

  it("keeps currencies apart when it cannot convert", () => {
    const p = queries.portfolio();
    expect(p.currency).toBeNull();
    expect(p.bySource).toEqual([]);
    expect(p.perCurrency).toEqual(expect.arrayContaining([
      { currency: "USD", cents: 50_000 }, { currency: "SGD", cents: 150_000 },
    ]));
  });

  it("folds past six sources into Other", async () => {
    for (const n of [1, 2, 3, 4, 5]) {
      await actions.createHolding({ ...base, name: `X${n}`, source: `S${n}`, currency: "SGD", valueCents: 1_000 * n });
    }
    const p = queries.portfolio(inSgd);
    expect(p.bySource).toHaveLength(6);
    expect(p.bySource.at(-1)).toMatchObject({ name: "Other", count: 2, totalCents: 3_000 });
  });

  it("validates, updates and deletes", async () => {
    await expect(actions.createHolding({ ...base, name: "", source: "S", currency: "SGD", valueCents: 1 })).rejects.toThrow();
    await expect(actions.createHolding({ ...base, name: "N", source: "S", currency: "dollars", valueCents: 1 })).rejects.toThrow();
    const id = await actions.createHolding({ ...base, name: "N", source: "S", currency: "sgd", valueCents: 1 });
    await actions.updateHolding(id, { valueCents: 2, asOf: "2000-02-01" });
    expect(queries.portfolio().holdings.find((h) => h.id === id)).toMatchObject({ currency: "SGD", valueCents: 2, asOf: "2000-02-01" });
    await actions.deleteHolding(id);
    expect(queries.portfolio().holdings.find((h) => h.id === id)).toBeUndefined();
  });
});
