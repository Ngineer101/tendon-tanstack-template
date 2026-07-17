CREATE TABLE `mcp_oauth_state` (
	`state` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`connection_id` text,
	`name` text NOT NULL,
	`server_url` text NOT NULL,
	`authorization_endpoint` text NOT NULL,
	`token_endpoint` text NOT NULL,
	`issuer` text,
	`client_id` text NOT NULL,
	`client_secret_encrypted` text,
	`code_verifier` text NOT NULL,
	`scope` text,
	`redirect_uri` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`connection_id`) REFERENCES `mcp_server_connection`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `mcp_server_connection` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`server_url` text NOT NULL,
	`status` text DEFAULT 'connected' NOT NULL,
	`auth_data_encrypted` text,
	`oauth_issuer` text,
	`oauth_client_id` text,
	`scopes` text,
	`last_tested_at` integer,
	`last_error` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mcp_server_connection_user_url_unique` ON `mcp_server_connection` (`user_id`,`server_url`);