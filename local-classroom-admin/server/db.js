const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");
const bcrypt = require("bcryptjs");
const { dbPath, lateCutoff } = require("./config");

fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const db = new Database(dbPath);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  full_name TEXT NOT NULL,
  email TEXT,
  role TEXT NOT NULL CHECK(role IN ('admin','teacher')),
  password_hash TEXT NOT NULL,
  wa_number TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  last_login_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS students (
  id TEXT PRIMARY KEY,
  nisn TEXT,
  full_name TEXT NOT NULL,
  class_name TEXT NOT NULL,
  gender TEXT,
  parent_name TEXT,
  parent_wa TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  qr_token TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS attendance (
  id TEXT PRIMARY KEY,
  date TEXT NOT NULL,
  student_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('hadir','sakit','izin','alfa')),
  check_in_time TEXT,
  is_late INTEGER NOT NULL DEFAULT 0,
  note TEXT,
  source TEXT NOT NULL,
  teacher_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(date, student_id),
  FOREIGN KEY(student_id) REFERENCES students(id),
  FOREIGN KEY(teacher_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS grades (
  id TEXT PRIMARY KEY,
  student_id TEXT NOT NULL,
  subject TEXT NOT NULL,
  objective_code TEXT NOT NULL,
  objective_text TEXT,
  nilai_harian REAL NOT NULL DEFAULT 0,
  nilai_tugas REAL NOT NULL DEFAULT 0,
  nilai_pts REAL NOT NULL DEFAULT 0,
  nilai_pas REAL NOT NULL DEFAULT 0,
  nilai_sikap REAL NOT NULL DEFAULT 0,
  nilai_produk REAL NOT NULL DEFAULT 0,
  final_score REAL NOT NULL DEFAULT 0,
  predicate TEXT NOT NULL DEFAULT 'D',
  semester TEXT NOT NULL,
  academic_year TEXT NOT NULL,
  teacher_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(student_id, subject, objective_code, semester, academic_year),
  FOREIGN KEY(student_id) REFERENCES students(id),
  FOREIGN KEY(teacher_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS journals (
  id TEXT PRIMARY KEY,
  tanggal TEXT NOT NULL,
  mata_pelajaran TEXT NOT NULL,
  tujuan_pembelajaran TEXT,
  materi TEXT,
  kendala TEXT,
  jam_waktu TEXT,
  teacher_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY(teacher_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS counseling (
  id TEXT PRIMARY KEY,
  tanggal TEXT NOT NULL,
  student_id TEXT NOT NULL,
  violation_type TEXT NOT NULL,
  handling TEXT,
  follow_up TEXT,
  result TEXT,
  teacher_id TEXT NOT NULL,
  parent_notified INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  FOREIGN KEY(student_id) REFERENCES students(id),
  FOREIGN KEY(teacher_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  user_id TEXT,
  payload_json TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_attendance_date ON attendance(date);
CREATE INDEX IF NOT EXISTS idx_attendance_student ON attendance(student_id);
CREATE INDEX IF NOT EXISTS idx_grades_student ON grades(student_id);
CREATE INDEX IF NOT EXISTS idx_counseling_date ON counseling(tanggal);
`);

function nowIso() {
  return new Date().toISOString();
}

function seedSettings() {
  const upsert = db.prepare(`
    INSERT INTO settings (key, value, updated_at)
    VALUES (@key, @value, @updated_at)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `);
  upsert.run({ key: "LATE_TIME", value: lateCutoff, updated_at: nowIso() });
  upsert.run({ key: "WEIGHT_HARIAN", value: "20", updated_at: nowIso() });
  upsert.run({ key: "WEIGHT_TUGAS", value: "20", updated_at: nowIso() });
  upsert.run({ key: "WEIGHT_PTS", value: "20", updated_at: nowIso() });
  upsert.run({ key: "WEIGHT_PAS", value: "25", updated_at: nowIso() });
  upsert.run({ key: "WEIGHT_SIKAP", value: "10", updated_at: nowIso() });
  upsert.run({ key: "WEIGHT_PRODUK", value: "5", updated_at: nowIso() });
}

function seedUsers() {
  const total = db.prepare("SELECT COUNT(*) as n FROM users").get().n;
  if (total > 0) return;
  const insertUser = db.prepare(`
    INSERT INTO users (id, username, full_name, email, role, password_hash, wa_number, is_active, created_at)
    VALUES (@id, @username, @full_name, @email, @role, @password_hash, @wa_number, 1, @created_at)
  `);
  insertUser.run({
    id: "USR-ADMIN",
    username: "admin",
    full_name: "Administrator Sekolah",
    email: "admin@local.school",
    role: "admin",
    password_hash: bcrypt.hashSync("admin123", 10),
    wa_number: "",
    created_at: nowIso()
  });
  insertUser.run({
    id: "USR-T001",
    username: "guru1",
    full_name: "Guru Kelas 4A",
    email: "guru1@local.school",
    role: "teacher",
    password_hash: bcrypt.hashSync("guru123", 10),
    wa_number: "",
    created_at: nowIso()
  });
}

seedSettings();
seedUsers();

module.exports = db;
