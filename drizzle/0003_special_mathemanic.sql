-- OAuth states are short-lived and cannot safely resume without a resource audience.
DELETE FROM `mcp_oauth_state`;--> statement-breakpoint
ALTER TABLE `mcp_oauth_state` ADD `resource` text DEFAULT '' NOT NULL;
