CREATE INDEX `mcp_oauth_state_user_expires_idx` ON `mcp_oauth_state` (`user_id`,`expires_at`);--> statement-breakpoint
CREATE INDEX `mcp_server_user_status_idx` ON `mcp_server` (`user_id`,`status`);