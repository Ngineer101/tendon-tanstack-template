CREATE TABLE `mcp_connection` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`server_url` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`auth_type` text DEFAULT 'oauth' NOT NULL,
	`credentials_encrypted` text,
	`last_error_code` text,
	`last_tested_at` integer,
	`last_connected_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mcp_connection_user_url_unique` ON `mcp_connection` (`user_id`,`server_url`);--> statement-breakpoint
CREATE TABLE `mcp_oauth_session` (
	`id` text PRIMARY KEY NOT NULL,
	`connection_id` text NOT NULL,
	`user_id` text NOT NULL,
	`state_hash` text NOT NULL,
	`payload_encrypted` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`connection_id`) REFERENCES `mcp_connection`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mcp_oauth_session_state_hash_unique` ON `mcp_oauth_session` (`state_hash`);