import path from "node:path";

/**
 * Where the database, its backups and stored statements live. The packaged
 * desktop app points this at the user's Library folder, because its server
 * runs from inside the read-only app bundle; everywhere else it is finance/data.
 */
export const DATA_DIR = process.env.FINANCE_DATA_DIR ?? path.join(process.cwd(), "data");

/**
 * Stored statement paths are recorded relative to the folder that holds the
 * data folder ("data/statements/DBS/…"), so rows written before the data folder
 * could move still resolve.
 */
export const FILES_ROOT = path.dirname(DATA_DIR);
