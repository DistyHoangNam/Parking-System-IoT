CREATE TABLE IF NOT EXISTS parking_lock (
  id INT PRIMARY KEY
) ENGINE=InnoDB;
INSERT IGNORE INTO parking_lock (id) VALUES (1);
CREATE TABLE IF NOT EXISTS admin_resets (
  sequence_id BIGINT UNSIGNED AUTO_INCREMENT UNIQUE,
  request_id CHAR(32) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  slot INT NULL,
  exit_operation CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  created_at BIGINT NOT NULL,
  completed_at BIGINT NULL,
  cancelled_count INT NOT NULL DEFAULT 0,
  status ENUM('PENDING','COMPLETED') NOT NULL
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS tickets (
  code CHAR(6) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  status ENUM('RESERVED','PARKED','EXIT_PENDING','COMPLETED','EXPIRED','CANCELLED') NOT NULL,
  slot INT NOT NULL,
  plate VARCHAR(16) NOT NULL,
  phone VARCHAR(16),
  ip VARCHAR(64),
  created_at BIGINT NOT NULL,
  expires_at BIGINT,
  entry_at BIGINT,
  exit_at BIGINT,
  fee BIGINT,
  paid_at BIGINT,
  exit_operation CHAR(36) CHARACTER SET ascii COLLATE ascii_bin UNIQUE,
  paid_hours INT,
  paid_parked_sec BIGINT,
  paid_rate BIGINT,
  paid_period_sec INT,
  admin_reset_id CHAR(32) CHARACTER SET ascii COLLATE ascii_bin,
  cancelled_at BIGINT,
  active_slot INT GENERATED ALWAYS AS (
    CASE WHEN status IN ('RESERVED','PARKED','EXIT_PENDING') THEN slot ELSE NULL END
  ) STORED,
  active_plate VARCHAR(16) GENERATED ALWAYS AS (
    CASE WHEN status IN ('RESERVED','PARKED','EXIT_PENDING')
      THEN REPLACE(REPLACE(REPLACE(UPPER(plate), '.', ''), '-', ''), ' ', '') ELSE NULL END
  ) STORED,
  UNIQUE KEY one_active_ticket_per_slot (active_slot),
  UNIQUE KEY one_active_ticket_per_plate (active_plate),
  KEY ticket_status_expiry (status, expires_at),
  KEY ticket_ip_status (ip, status)
) ENGINE=InnoDB;
