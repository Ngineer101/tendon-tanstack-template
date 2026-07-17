CREATE TABLE `mcp_oauth_state` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`server_id` text,
	`server_name` text NOT NULL,
	`server_url` text NOT NULL,
	`redirect_uri` text NOT NULL,
	`scopes` text,
	`oauth_metadata` text NOT NULL,
	`encrypted_code_verifier` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`server_id`) REFERENCES `mcp_server`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `mcp_server` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`server_url` text NOT NULL,
	`status` text NOT NULL,
	`oauth_issuer` text,
	`authorization_endpoint` text,
	`token_endpoint` text,
	`scopes` text,
	`encrypted_auth_data` text,
	`last_test_status` text,
	`last_error` text,
	`last_test_at` integer,
	`connected_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mcp_server_user_server_url_unique` ON `mcp_server` (`user_id`,`server_url`);