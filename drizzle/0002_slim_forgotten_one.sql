CREATE TABLE `mcp_server` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`label` text NOT NULL,
	`url` text NOT NULL,
	`auth_type` text,
	`encrypted_auth_data` text,
	`oauth_state` text,
	`status` text DEFAULT 'disconnected' NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
