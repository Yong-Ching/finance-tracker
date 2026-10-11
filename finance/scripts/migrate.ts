import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { openDb } from "../src/db/raw";
import fs from "node:fs";
import path from "node:path";

fs.mkdirSync(path.join(process.cwd(), "data"), { recursive: true });
const { db, conn } = openDb();
migrate(db, { migrationsFolder: path.join(process.cwd(), "drizzle") });
conn.close();
console.log("migrations applied");
