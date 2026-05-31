CREATE TABLE `billing_account` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`stripe_customer_id` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `billing_account_user_id_unique` ON `billing_account` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `billing_account_stripe_customer_id_unique` ON `billing_account` (`stripe_customer_id`);--> statement-breakpoint
CREATE TABLE `credit_balance` (
	`billing_account_id` text PRIMARY KEY NOT NULL,
	`balance` integer DEFAULT 0 NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`billing_account_id`) REFERENCES `billing_account`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `credit_transaction` (
	`id` text PRIMARY KEY NOT NULL,
	`billing_account_id` text NOT NULL,
	`amount` integer NOT NULL,
	`type` text NOT NULL,
	`description` text,
	`reference` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`billing_account_id`) REFERENCES `billing_account`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `credit_transaction_reference_unique` ON `credit_transaction` (`reference`);--> statement-breakpoint
CREATE TABLE `stripe_event` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`processed_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `subscription` (
	`id` text PRIMARY KEY NOT NULL,
	`billing_account_id` text NOT NULL,
	`stripe_subscription_id` text NOT NULL,
	`stripe_price_id` text,
	`plan` text NOT NULL,
	`status` text NOT NULL,
	`cancel_at_period_end` integer DEFAULT false NOT NULL,
	`current_period_end` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`billing_account_id`) REFERENCES `billing_account`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `subscription_stripe_subscription_id_unique` ON `subscription` (`stripe_subscription_id`);