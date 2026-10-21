CREATE TABLE `fx_rates` (
	`currency` text PRIMARY KEY NOT NULL,
	`per_base` real NOT NULL,
	`as_of` text NOT NULL,
	`fetched_at` integer DEFAULT (unixepoch()) NOT NULL
);
