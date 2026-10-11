CREATE TABLE `accounts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`institution` text NOT NULL,
	`kind` text NOT NULL,
	`currency` text DEFAULT 'SGD' NOT NULL,
	`is_pocket` integer DEFAULT false NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `accounts_name_unique` ON `accounts` (`name`);--> statement-breakpoint
CREATE TABLE `categories` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`bucket` text NOT NULL,
	`parent_id` integer,
	`archived` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `categories_name_unique` ON `categories` (`name`);--> statement-breakpoint
CREATE INDEX `categories_bucket_idx` ON `categories` (`bucket`);--> statement-breakpoint
CREATE TABLE `overrides` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`dedupe_hash` text NOT NULL,
	`category_id` integer,
	`txn_type` text,
	`seen` integer,
	`note` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `overrides_hash_idx` ON `overrides` (`dedupe_hash`);--> statement-breakpoint
CREATE TABLE `rules` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`pattern` text NOT NULL,
	`match_type` text DEFAULT 'substring' NOT NULL,
	`account_id` integer,
	`category_id` integer NOT NULL,
	`txn_type` text NOT NULL,
	`seen` integer DEFAULT true NOT NULL,
	`priority` integer DEFAULT 100 NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`amount_cents` integer,
	`day_max` integer,
	`note` text,
	`hit_count` integer DEFAULT 0 NOT NULL,
	`last_matched_at` integer,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `rules_priority_idx` ON `rules` (`priority`);--> statement-breakpoint
CREATE TABLE `statements` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer NOT NULL,
	`filename` text NOT NULL,
	`sha256` text NOT NULL,
	`stored_path` text,
	`period_from` text,
	`period_to` text,
	`opening_balance_cents` integer,
	`closing_balance_cents` integer,
	`continuity_delta` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'imported' NOT NULL,
	`parser_name` text NOT NULL,
	`parser_version` text NOT NULL,
	`imported_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `statements_sha256_idx` ON `statements` (`sha256`);--> statement-breakpoint
CREATE INDEX `statements_account_idx` ON `statements` (`account_id`);--> statement-breakpoint
CREATE TABLE `transactions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`statement_id` integer,
	`account_id` integer NOT NULL,
	`txn_date` text NOT NULL,
	`post_date` text,
	`description_raw` text NOT NULL,
	`description_clean` text,
	`amount_cents` integer NOT NULL,
	`currency_original` text DEFAULT 'SGD' NOT NULL,
	`amount_original_cents` integer,
	`fx_rate` real,
	`balance_after_cents` integer,
	`category_id` integer,
	`txn_type` text NOT NULL,
	`seen` integer DEFAULT true NOT NULL,
	`note` text,
	`tags` text,
	`is_recurring` integer DEFAULT false NOT NULL,
	`is_reviewed` integer DEFAULT false NOT NULL,
	`matched_rule_id` integer,
	`dedupe_hash` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`statement_id`) REFERENCES `statements`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `txn_date_idx` ON `transactions` (`txn_date`);--> statement-breakpoint
CREATE INDEX `txn_account_idx` ON `transactions` (`account_id`);--> statement-breakpoint
CREATE INDEX `txn_category_idx` ON `transactions` (`category_id`);--> statement-breakpoint
CREATE INDEX `txn_type_idx` ON `transactions` (`txn_type`);--> statement-breakpoint
CREATE INDEX `txn_review_idx` ON `transactions` (`is_reviewed`);--> statement-breakpoint
CREATE INDEX `txn_dedupe_idx` ON `transactions` (`dedupe_hash`);--> statement-breakpoint
CREATE TABLE `transfer_links` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`source_txn_id` integer NOT NULL,
	`target_txn_id` integer NOT NULL,
	`kind` text NOT NULL,
	`amount_cents` integer NOT NULL,
	`date_gap_days` integer NOT NULL,
	`confidence` real NOT NULL,
	`method` text NOT NULL,
	`status` text DEFAULT 'proposed' NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`source_txn_id`) REFERENCES `transactions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`target_txn_id`) REFERENCES `transactions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `links_pair_idx` ON `transfer_links` (`source_txn_id`,`target_txn_id`);--> statement-breakpoint
CREATE INDEX `links_status_idx` ON `transfer_links` (`status`);