export type Env = Cloudflare.Env;

export type UserRole = "user" | "admin";
export type JobAction = "entry" | "exit";
export type JobStatus = "scheduled" | "claimed" | "running" | "success" | "failed" | "uncertain" | "skipped" | "missed";

export interface UserRow {
  id: string;
  username: string;
  display_name: string;
  role: UserRole;
  password_hash: string;
  password_salt: string;
  pin_ciphertext: string;
  pin_iv: string;
  enabled: number;
  margin_seconds: number;
  time_zone: string;
  created_at: number;
  updated_at: number;
}

export interface ScheduleRow {
  user_id: string;
  weekday: number;
  enabled: number;
  entry_time: string;
  exit_time: string;
}

export interface JobRow {
  id: string;
  user_id: string;
  local_date: string;
  action: JobAction;
  target_at: number;
  status: JobStatus;
  attempt_count: number;
  claimed_at: number | null;
  executed_at: number | null;
  timenet_time: string | null;
  error_code: string | null;
  error_message: string | null;
  created_at: number;
  updated_at: number;
}

export interface SessionUser {
  id: string;
  username: string;
  displayName: string;
  role: UserRole;
}
