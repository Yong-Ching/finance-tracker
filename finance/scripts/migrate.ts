import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { openDb } from "../src/db/raw";
import { DATA_DIR } from "../src/lib/paths";
import fs from "node:fs";
import path from "node:path";

fs.mkdirSync(DATA_DIR, { recursive: true });
const { db, conn } = openDb();
// The packaged app ships the migrations outside its compiled copy of this script.
migrate(db, { migrationsFolder: process.env.FINANCE_MIGRATIONS ?? path.join(process.cwd(), "drizzle") });
conn.close();
console.log("migrations applied");
