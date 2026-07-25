import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

const schema = `
  PRAGMA foreign_keys = ON;
  PRAGMA journal_mode = WAL;
  PRAGMA busy_timeout = 5000;

  CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS players (
    id TEXT PRIMARY KEY,
    client_request_id TEXT NOT NULL UNIQUE,
    nickname TEXT,
    avatar_id TEXT NOT NULL,
    level INTEGER NOT NULL DEFAULT 1 CHECK(level >= 1),
    exp INTEGER NOT NULL DEFAULT 0 CHECK(exp >= 0),
    gold INTEGER NOT NULL DEFAULT 0 CHECK(gold >= 0),
    completed_run_count INTEGER NOT NULL DEFAULT 0 CHECK(completed_run_count >= 0),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS player_sessions (
    id TEXT PRIMARY KEY,
    player_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS player_skills (
    player_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
    skill_name TEXT NOT NULL,
    mastery_score INTEGER NOT NULL DEFAULT 50 CHECK(mastery_score BETWEEN 0 AND 100),
    current_tier INTEGER NOT NULL DEFAULT 1 CHECK(current_tier BETWEEN 1 AND 3),
    attempt_count INTEGER NOT NULL DEFAULT 0,
    correct_count INTEGER NOT NULL DEFAULT 0,
    hint_count INTEGER NOT NULL DEFAULT 0,
    ai_weight_multiplier REAL NOT NULL DEFAULT 1 CHECK(ai_weight_multiplier BETWEEN 0.8 AND 1.2),
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (player_id, skill_name)
  );

  CREATE TABLE IF NOT EXISTS game_runs (
    id TEXT PRIMARY KEY,
    player_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
    client_request_id TEXT NOT NULL,
    map_id TEXT NOT NULL,
    level_id TEXT NOT NULL,
    sequence_no INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE', 'COMPLETED', 'ABANDONED')),
    target_question_count INTEGER NOT NULL DEFAULT 5 CHECK(target_question_count = 5),
    answered_count INTEGER NOT NULL DEFAULT 0,
    correct_count INTEGER NOT NULL DEFAULT 0,
    reward_exp INTEGER NOT NULL DEFAULT 0,
    reward_gold INTEGER NOT NULL DEFAULT 0,
    started_at INTEGER NOT NULL,
    completed_at INTEGER,
    UNIQUE (player_id, client_request_id)
  );

  CREATE TABLE IF NOT EXISTS question_attempts (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES game_runs(id) ON DELETE CASCADE,
    player_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
    question_snapshot_json TEXT NOT NULL,
    skill_name TEXT NOT NULL,
    difficulty_tier INTEGER NOT NULL CHECK(difficulty_tier BETWEEN 1 AND 3),
    sequence_no INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'ISSUED' CHECK(status IN ('ISSUED', 'ANSWERED')),
    hint_used INTEGER NOT NULL DEFAULT 0 CHECK(hint_used IN (0, 1)),
    response_count INTEGER NOT NULL DEFAULT 0,
    first_attempt_correct INTEGER,
    assisted INTEGER NOT NULL DEFAULT 0 CHECK(assisted IN (0, 1)),
    issued_at INTEGER NOT NULL,
    answered_at INTEGER,
    UNIQUE (run_id, sequence_no)
  );

  CREATE TABLE IF NOT EXISTS answer_events (
    id TEXT PRIMARY KEY,
    attempt_id TEXT NOT NULL REFERENCES question_attempts(id) ON DELETE CASCADE,
    selected_option_id TEXT NOT NULL,
    client_elapsed_ms INTEGER NOT NULL,
    correct INTEGER NOT NULL CHECK(correct IN (0, 1)),
    result_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE (attempt_id, id)
  );

  CREATE TABLE IF NOT EXISTS ai_jobs (
    id TEXT PRIMARY KEY,
    player_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
    checkpoint_no INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED')),
    attempts INTEGER NOT NULL DEFAULT 0,
    input_summary_json TEXT NOT NULL,
    last_error_code TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (player_id, checkpoint_no)
  );

  CREATE TABLE IF NOT EXISTS ai_reports (
    id TEXT PRIMARY KEY,
    player_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
    checkpoint_no INTEGER NOT NULL,
    source TEXT NOT NULL CHECK(source IN ('rules', 'ai')),
    report_json TEXT NOT NULL,
    model TEXT,
    prompt_version TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (player_id, checkpoint_no)
  );

  CREATE INDEX IF NOT EXISTS idx_sessions_token_hash ON player_sessions(token_hash);
  CREATE INDEX IF NOT EXISTS idx_runs_player_sequence ON game_runs(player_id, sequence_no);
  CREATE INDEX IF NOT EXISTS idx_attempts_player_issued ON question_attempts(player_id, issued_at);
  CREATE INDEX IF NOT EXISTS idx_ai_jobs_status ON ai_jobs(status, updated_at);
`;

export function openDatabase(databasePath) {
  if (databasePath !== ':memory:') {
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  }

  const db = new Database(databasePath);
  db.exec(schema);
  db.prepare('INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (?, ?)').run(1, Date.now());
  return db;
}
