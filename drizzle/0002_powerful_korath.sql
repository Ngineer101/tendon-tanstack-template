CREATE TABLE `mcp_oauth_transaction` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`server_url` text NOT NULL,
	`server_name` text NOT NULL,
	`encrypted_payload` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `mcp_server` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`url` text NOT NULL,
	`status` text DEFAULT 'requires_auth' NOT NULL,
	`auth_type` text DEFAULT 'oauth' NOT NULL,
	`encrypted_auth` text,
	`server_name` text,
	`server_version` text,
	`last_error` text,
	`last_tested_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mcp_server_user_id_url_unique` ON `mcp_server` (`user_id`,`url`);