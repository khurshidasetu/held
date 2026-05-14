CREATE TABLE `attendees` (
	`id` varchar(36) NOT NULL,
	`meeting_id` varchar(36) NOT NULL,
	`email` varchar(320) NOT NULL,
	`name` varchar(255),
	CONSTRAINT `attendees_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `email_sends` (
	`id` varchar(36) NOT NULL,
	`meeting_id` varchar(36) NOT NULL,
	`recipient_email` varchar(320) NOT NULL,
	`sent_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
	`postmark_message_id` varchar(128),
	CONSTRAINT `email_sends_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `meeting_summaries` (
	`id` varchar(36) NOT NULL,
	`meeting_id` varchar(36) NOT NULL,
	`summary` text NOT NULL,
	`action_items` json NOT NULL,
	`decisions` json NOT NULL,
	`topics` json NOT NULL,
	`created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT `meeting_summaries_id` PRIMARY KEY(`id`),
	CONSTRAINT `meeting_summaries_meeting_uniq` UNIQUE(`meeting_id`)
);
--> statement-breakpoint
CREATE TABLE `meetings` (
	`id` varchar(36) NOT NULL,
	`user_id` varchar(255) NOT NULL,
	`title` varchar(500) NOT NULL,
	`audio_url` varchar(1024),
	`duration_seconds` int,
	`status` enum('pending','awaiting_speaker_naming','processing','complete','failed') NOT NULL DEFAULT 'pending',
	`error_message` text,
	`diarization_segments` json,
	`created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT `meetings_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `speakers` (
	`id` varchar(36) NOT NULL,
	`meeting_id` varchar(36) NOT NULL,
	`speaker_label` varchar(64) NOT NULL,
	`display_name` varchar(255),
	`is_silent_attendee` boolean NOT NULL DEFAULT false,
	`sample_audio_url` varchar(1024),
	`created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT `speakers_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `transcript_segments` (
	`id` varchar(36) NOT NULL,
	`meeting_id` varchar(36) NOT NULL,
	`speaker_id` varchar(36) NOT NULL,
	`start_seconds` double NOT NULL,
	`end_seconds` double NOT NULL,
	`text` text NOT NULL,
	CONSTRAINT `transcript_segments_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `attendees` ADD CONSTRAINT `attendees_meeting_id_meetings_id_fk` FOREIGN KEY (`meeting_id`) REFERENCES `meetings`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `email_sends` ADD CONSTRAINT `email_sends_meeting_id_meetings_id_fk` FOREIGN KEY (`meeting_id`) REFERENCES `meetings`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `meeting_summaries` ADD CONSTRAINT `meeting_summaries_meeting_id_meetings_id_fk` FOREIGN KEY (`meeting_id`) REFERENCES `meetings`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `speakers` ADD CONSTRAINT `speakers_meeting_id_meetings_id_fk` FOREIGN KEY (`meeting_id`) REFERENCES `meetings`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `transcript_segments` ADD CONSTRAINT `transcript_segments_meeting_id_meetings_id_fk` FOREIGN KEY (`meeting_id`) REFERENCES `meetings`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `transcript_segments` ADD CONSTRAINT `transcript_segments_speaker_id_speakers_id_fk` FOREIGN KEY (`speaker_id`) REFERENCES `speakers`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `attendees_meeting_idx` ON `attendees` (`meeting_id`);--> statement-breakpoint
CREATE INDEX `emails_meeting_idx` ON `email_sends` (`meeting_id`);--> statement-breakpoint
CREATE INDEX `meetings_user_idx` ON `meetings` (`user_id`);--> statement-breakpoint
CREATE INDEX `meetings_status_idx` ON `meetings` (`status`);--> statement-breakpoint
CREATE INDEX `speakers_meeting_idx` ON `speakers` (`meeting_id`);--> statement-breakpoint
CREATE INDEX `segments_meeting_idx` ON `transcript_segments` (`meeting_id`);--> statement-breakpoint
CREATE INDEX `segments_meeting_start_idx` ON `transcript_segments` (`meeting_id`,`start_seconds`);