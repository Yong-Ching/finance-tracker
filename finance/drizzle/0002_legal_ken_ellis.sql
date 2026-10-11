CREATE TABLE `ai_reviews` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`statement_id` integer,
	`model` text NOT NULL,
	`sent_count` integer NOT NULL,
	`skipped_existing_count` integer DEFAULT 0 NOT NULL,
	`input_tokens` integer,
	`output_tokens` integer,
	`error` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`statement_id`) REFERENCES `statements`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `ai_suggestions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`review_id` integer NOT NULL,
	`kind` text NOT NULL,
	`dedupe_hash` text,
	`category_id` integer,
	`new_category_name` text,
	`txn_type` text,
	`pattern` text,
	`flag_type` text,
	`confidence` real DEFAULT 0 NOT NULL,
	`reasoning` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`review_id`) REFERENCES `ai_reviews`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `sugg_hash_idx` ON `ai_suggestions` (`dedupe_hash`);--> statement-breakpoint
CREATE INDEX `sugg_status_idx` ON `ai_suggestions` (`status`);--> statement-breakpoint
CREATE INDEX `sugg_kind_idx` ON `ai_suggestions` (`kind`);