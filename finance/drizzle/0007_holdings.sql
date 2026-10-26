CREATE TABLE `holdings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`source` text NOT NULL,
	`asset_class` text DEFAULT 'other' NOT NULL,
	`currency` text DEFAULT 'SGD' NOT NULL,
	`value_cents` integer NOT NULL,
	`cost_cents` integer,
	`as_of` text NOT NULL,
	`note` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `holdings_source_idx` ON `holdings` (`source`);