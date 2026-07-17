CREATE TABLE `mcp_oauth_session` (
	`state` text PRIMARY KEY NOT NULL,
	`server_id` text NOT NULL,
	`user_id` text NOT NULL,
	`code_verifier_enc` text NOT NULL,
	`redirect_uri` text NOT NULL,
	`resource` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`server_id`) REFERENCES `mcp_server`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `mcp_server` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`url` text NOT NULL,
	`status` text DEFAULT 'pending_auth' NOT NULL,
	`auth_type` text,
	`oauth_issuer` text,
	`oauth_metadata` text,
	`client_id` text,
	`client_secret_enc` text,
	`access_token_enc` text,
	`refresh_token_enc` text,
	`access_token_expires_at` integer,
	`scope` text,
	`server_info` text,
	`last_connected_at` integer,
	`last_tested_at` integer,
	`last_error` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mcp_server_user_id_url_unique` ON `mcp_server` (`user_id`,`url`);