CREATE TABLE "audit_log" (
	"id" serial PRIMARY KEY NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"user_id" uuid,
	"user_email" text,
	"action" text NOT NULL,
	"target" text,
	"detail" jsonb,
	"ip" text
);
--> statement-breakpoint
CREATE TABLE "app_settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "alert_rule_state" (
	"rule_id" integer PRIMARY KEY NOT NULL,
	"condition_since" timestamp with time zone,
	"active_since" timestamp with time zone,
	"last_resolution" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "deployment_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"deployment_uuid" text NOT NULL,
	"status" text NOT NULL,
	"previous_status" text,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"application_uuid" text,
	"application_name" text,
	"branch" text,
	"commit_sha" text,
	"commit_message" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"duration_seconds" integer,
	"url" text
);
--> statement-breakpoint
CREATE TABLE "hosts" (
	"id" text PRIMARY KEY NOT NULL,
	"hostname" text NOT NULL,
	"kernel" text NOT NULL,
	"distro" text NOT NULL,
	"arch" text NOT NULL,
	"cores" integer NOT NULL,
	"first_seen" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "alert_instances" (
	"id" serial PRIMARY KEY NOT NULL,
	"rule_id" integer NOT NULL,
	"state" text DEFAULT 'activa' NOT NULL,
	"trigger_value" double precision NOT NULL,
	"threshold" double precision NOT NULL,
	"severity" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"acknowledged_at" timestamp with time zone,
	"acknowledged_by" uuid
);
--> statement-breakpoint
CREATE TABLE "live_snapshots" (
	"host_id" text PRIMARY KEY NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"payload" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "login_attempts" (
	"id" serial PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"successful" boolean NOT NULL
);
--> statement-breakpoint
CREATE TABLE "collector_heartbeats" (
	"host_id" text PRIMARY KEY NOT NULL,
	"last_seen" timestamp with time zone DEFAULT now() NOT NULL,
	"version" text NOT NULL,
	"sample_interval_seconds" integer NOT NULL,
	"capabilities" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "container_metric_samples" (
	"host_id" text NOT NULL,
	"container_id" text NOT NULL,
	"resolution" text NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"name" text NOT NULL,
	"image" text NOT NULL,
	"state" text NOT NULL,
	"health" text NOT NULL,
	"cpu_percent" real NOT NULL,
	"memory_bytes" bigint NOT NULL,
	"memory_limit_bytes" bigint,
	"net_rx_bps" double precision NOT NULL,
	"net_tx_bps" double precision NOT NULL,
	"block_read_bps" double precision NOT NULL,
	"block_write_bps" double precision NOT NULL,
	"uptime_seconds" bigint NOT NULL,
	"restarts" integer NOT NULL,
	"ports" jsonb NOT NULL,
	"coolify_application" text,
	"coolify_uuid" text,
	"sample_count" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "container_metric_samples_host_id_container_id_resolution_ts_pk" PRIMARY KEY("host_id","container_id","resolution","ts")
);
--> statement-breakpoint
CREATE TABLE "disk_metric_samples" (
	"host_id" text NOT NULL,
	"resolution" text NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"device" text NOT NULL,
	"read_bps" double precision NOT NULL,
	"write_bps" double precision NOT NULL,
	"read_ops" double precision NOT NULL,
	"write_ops" double precision NOT NULL,
	"utilization" real,
	"read_latency_ms" real,
	"write_latency_ms" real,
	"sample_count" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "disk_metric_samples_host_id_resolution_ts_device_pk" PRIMARY KEY("host_id","resolution","ts","device")
);
--> statement-breakpoint
CREATE TABLE "filesystem_metric_samples" (
	"host_id" text NOT NULL,
	"resolution" text NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"mount_point" text NOT NULL,
	"device" text NOT NULL,
	"fstype" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"used_bytes" bigint NOT NULL,
	"available_bytes" bigint NOT NULL,
	"inodes_total" bigint,
	"inodes_used" bigint,
	"sample_count" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "filesystem_metric_samples_host_id_resolution_ts_mount_point_pk" PRIMARY KEY("host_id","resolution","ts","mount_point")
);
--> statement-breakpoint
CREATE TABLE "host_metric_samples" (
	"host_id" text NOT NULL,
	"resolution" text NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"cpu_total" real NOT NULL,
	"cpu_user" real NOT NULL,
	"cpu_system" real NOT NULL,
	"cpu_nice" real NOT NULL,
	"cpu_idle" real NOT NULL,
	"cpu_iowait" real NOT NULL,
	"cpu_irq" real NOT NULL,
	"cpu_softirq" real NOT NULL,
	"cpu_steal" real NOT NULL,
	"cpu_per_core" jsonb NOT NULL,
	"load_1" real NOT NULL,
	"load_5" real NOT NULL,
	"load_15" real NOT NULL,
	"cores" integer NOT NULL,
	"mem_total" bigint NOT NULL,
	"mem_used" bigint NOT NULL,
	"mem_available" bigint NOT NULL,
	"mem_free" bigint NOT NULL,
	"mem_cached" bigint NOT NULL,
	"mem_buffers" bigint NOT NULL,
	"swap_total" bigint NOT NULL,
	"swap_used" bigint NOT NULL,
	"uptime_seconds" bigint NOT NULL,
	"net_rx_bps" double precision NOT NULL,
	"net_tx_bps" double precision NOT NULL,
	"disk_read_bps" double precision NOT NULL,
	"disk_write_bps" double precision NOT NULL,
	"tcp_established" integer,
	"tcp_listen" integer,
	"tcp_time_wait" integer,
	"tcp_total" integer,
	"psi_cpu_some10" real,
	"psi_mem_some10" real,
	"psi_io_some10" real,
	"pressure_detail" jsonb,
	"processes" jsonb,
	"temperatures" jsonb,
	"sample_count" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "host_metric_samples_host_id_resolution_ts_pk" PRIMARY KEY("host_id","resolution","ts")
);
--> statement-breakpoint
CREATE TABLE "network_metric_samples" (
	"host_id" text NOT NULL,
	"resolution" text NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"interface" text NOT NULL,
	"rx_bps" double precision NOT NULL,
	"tx_bps" double precision NOT NULL,
	"rx_pps" double precision NOT NULL,
	"tx_pps" double precision NOT NULL,
	"rx_errors" bigint NOT NULL,
	"tx_errors" bigint NOT NULL,
	"rx_drops" bigint NOT NULL,
	"tx_drops" bigint NOT NULL,
	"sample_count" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "network_metric_samples_host_id_resolution_ts_interface_pk" PRIMARY KEY("host_id","resolution","ts","interface")
);
--> statement-breakpoint
CREATE TABLE "alert_rules" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"metric" text NOT NULL,
	"operator" text NOT NULL,
	"threshold" double precision NOT NULL,
	"severity" text NOT NULL,
	"min_duration_seconds" integer DEFAULT 60 NOT NULL,
	"cooldown_seconds" integer DEFAULT 300 NOT NULL,
	"hysteresis" double precision DEFAULT 0 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"silenced_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ip" text,
	"user_agent" text
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"name" text NOT NULL,
	"role" text DEFAULT 'admin' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"disabled_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alert_rule_state" ADD CONSTRAINT "alert_rule_state_rule_id_alert_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."alert_rules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alert_instances" ADD CONSTRAINT "alert_instances_rule_id_alert_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."alert_rules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alert_instances" ADD CONSTRAINT "alert_instances_acknowledged_by_users_id_fk" FOREIGN KEY ("acknowledged_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collector_heartbeats" ADD CONSTRAINT "collector_heartbeats_host_id_hosts_id_fk" FOREIGN KEY ("host_id") REFERENCES "public"."hosts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_log_at_idx" ON "audit_log" USING btree ("at");--> statement-breakpoint
CREATE INDEX "audit_log_user_idx" ON "audit_log" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "deployment_events_uuid_status_idx" ON "deployment_events" USING btree ("deployment_uuid","status");--> statement-breakpoint
CREATE INDEX "deployment_events_observed_idx" ON "deployment_events" USING btree ("observed_at");--> statement-breakpoint
CREATE INDEX "deployment_events_uuid_idx" ON "deployment_events" USING btree ("deployment_uuid");--> statement-breakpoint
CREATE INDEX "alert_instances_state_idx" ON "alert_instances" USING btree ("state","started_at");--> statement-breakpoint
CREATE INDEX "alert_instances_rule_idx" ON "alert_instances" USING btree ("rule_id");--> statement-breakpoint
CREATE UNIQUE INDEX "alert_instances_una_abierta_idx" ON "alert_instances" USING btree ("rule_id") WHERE "alert_instances"."state" <> 'resuelta';--> statement-breakpoint
CREATE INDEX "login_attempts_key_at_idx" ON "login_attempts" USING btree ("key","at");--> statement-breakpoint
CREATE INDEX "container_samples_res_ts_idx" ON "container_metric_samples" USING btree ("resolution","ts");--> statement-breakpoint
CREATE INDEX "container_samples_ts_idx" ON "container_metric_samples" USING btree ("ts");--> statement-breakpoint
CREATE INDEX "disk_samples_res_ts_idx" ON "disk_metric_samples" USING btree ("resolution","ts");--> statement-breakpoint
CREATE INDEX "fs_samples_res_ts_idx" ON "filesystem_metric_samples" USING btree ("resolution","ts");--> statement-breakpoint
CREATE INDEX "host_samples_res_ts_idx" ON "host_metric_samples" USING btree ("resolution","ts");--> statement-breakpoint
CREATE INDEX "net_samples_res_ts_idx" ON "network_metric_samples" USING btree ("resolution","ts");--> statement-breakpoint
CREATE UNIQUE INDEX "alert_rules_name_idx" ON "alert_rules" USING btree ("name");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_expires_idx" ON "sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_idx" ON "users" USING btree (lower("email"));