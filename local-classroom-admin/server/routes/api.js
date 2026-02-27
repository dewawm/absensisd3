const express = require("express");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const QRCode = require("qrcode");
const db = require("../db");
const { jwtSecret, lateCutoff } = require("../config");
const { authRequired, requireRole } = require("../middleware/auth");
const { sendWhatsAppMessage } = require("../services/whatsappService");
const {
  ATTENDANCE_STATUSES,
  SUBJECTS,
  uid,
  nowIso,
  dateKey,
  timeKey,
  normalizePhone,
  isLate,
  clampScore,
  scorePredicate,
  academicYearNow
} = require("../utils");

const router = express.Router();

function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

function logAudit(eventType, userId, payload = {}) {
  db.prepare(
    `INSERT INTO audit_logs (id, event_type, user_id, payload_json, created_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(uid("LOG"), eventType, userId || null, JSON.stringify(payload), nowIso());
}

function getSettingsMap() {
  const rows = db.prepare("SELECT key, value FROM settings").all();
  return rows.reduce((acc, row) => {
    acc[row.key] = row.value;
    return acc;
  }, {});
}

function calculateFinalScore(payload) {
  const settings = getSettingsMap();
  const w = {
    harian: Number(settings.WEIGHT_HARIAN || 20),
    tugas: Number(settings.WEIGHT_TUGAS || 20),
    pts: Number(settings.WEIGHT_PTS || 20),
    pas: Number(settings.WEIGHT_PAS || 25),
    sikap: Number(settings.WEIGHT_SIKAP || 10),
    produk: Number(settings.WEIGHT_PRODUK || 5)
  };
  const total = w.harian + w.tugas + w.pts + w.pas + w.sikap + w.produk || 100;
  const score =
    (clampScore(payload.nilai_harian) * w.harian +
      clampScore(payload.nilai_tugas) * w.tugas +
      clampScore(payload.nilai_pts) * w.pts +
      clampScore(payload.nilai_pas) * w.pas +
      clampScore(payload.nilai_sikap) * w.sikap +
      clampScore(payload.nilai_produk) * w.produk) /
    total;
  const rounded = Math.round(score * 100) / 100;
  return { finalScore: rounded, predicate: scorePredicate(rounded) };
}

function getStudentById(studentId) {
  return db.prepare("SELECT * FROM students WHERE id = ?").get(studentId);
}

function parseQrPayload(raw = "") {
  const parts = String(raw).split("|");
  if (parts.length !== 3 || parts[0] !== "STU") return null;
  return { studentId: parts[1], token: parts[2] };
}

async function resolveStudent({ studentId, qrData }) {
  if (studentId) {
    const student = getStudentById(studentId);
    if (!student) throw new Error("Siswa tidak ditemukan.");
    return student;
  }
  if (!qrData) throw new Error("studentId atau qrData wajib diisi.");
  const parsed = parseQrPayload(qrData);
  if (!parsed) throw new Error("Format QR tidak valid.");
  const student = getStudentById(parsed.studentId);
  if (!student) throw new Error("Siswa QR tidak ditemukan.");
  if (String(student.qr_token || "") !== parsed.token) {
    throw new Error("Token QR tidak cocok.");
  }
  return student;
}

function buildDailyRecap(date, totalStudents) {
  const rows = db.prepare("SELECT status, is_late FROM attendance WHERE date = ?").all(date);
  const recap = { date, total_students: totalStudents, hadir: 0, sakit: 0, izin: 0, alfa: 0, late_count: 0 };
  rows.forEach((row) => {
    recap[row.status] = (recap[row.status] || 0) + 1;
    if (row.is_late) recap.late_count += 1;
  });
  recap.present_rate = totalStudents ? Math.round((recap.hadir / totalStudents) * 10000) / 100 : 0;
  return recap;
}

function buildMonthlyRecap(month, year, totalStudents) {
  const m = String(month).padStart(2, "0");
  const y = String(year);
  const rows = db
    .prepare("SELECT date, status, is_late FROM attendance WHERE strftime('%m', date)=? AND strftime('%Y', date)=?")
    .all(m, y);
  const grouped = {};
  rows.forEach((row) => {
    if (!grouped[row.date]) {
      grouped[row.date] = { date: row.date, hadir: 0, sakit: 0, izin: 0, alfa: 0, late_count: 0 };
    }
    grouped[row.date][row.status] += 1;
    if (row.is_late) grouped[row.date].late_count += 1;
  });
  const days = Object.values(grouped).sort((a, b) => a.date.localeCompare(b.date));
  const totals = days.reduce(
    (acc, row) => {
      acc.hadir += row.hadir;
      acc.sakit += row.sakit;
      acc.izin += row.izin;
      acc.alfa += row.alfa;
      acc.late_count += row.late_count;
      return acc;
    },
    { hadir: 0, sakit: 0, izin: 0, alfa: 0, late_count: 0 }
  );
  return { month: Number(month), year: Number(year), days, totals, total_students: totalStudents };
}

async function sendAttendanceNotification(student, attendance) {
  const message =
    `Yth. Orang Tua/Wali ${student.full_name},\n` +
    `Presensi tercatat:\n` +
    `- Tanggal: ${attendance.date}\n` +
    `- Status: ${attendance.status.toUpperCase()}\n` +
    `- Jam: ${attendance.check_in_time}\n` +
    `- Terlambat: ${attendance.is_late ? "Ya" : "Tidak"}`;
  return sendWhatsAppMessage(normalizePhone(student.parent_wa), message);
}

async function sendCounselingNotification(student, row) {
  const message =
    `Pemberitahuan Buku Konseling\n` +
    `Siswa: ${student.full_name}\n` +
    `Tanggal: ${row.tanggal}\n` +
    `Pelanggaran: ${row.violation_type}\n` +
    `Penanganan: ${row.handling}\n` +
    `Follow up: ${row.follow_up}\n` +
    `Hasil: ${row.result}`;
  return sendWhatsAppMessage(normalizePhone(student.parent_wa), message);
}

async function upsertAttendanceRecord({ userId, data }) {
  const student = await resolveStudent({ studentId: data.student_id, qrData: data.qr_data });
  const settings = getSettingsMap();
  const date = String(data.date || dateKey()).trim();
  const checkIn = String(data.check_in_time || timeKey()).trim();
  const status = ATTENDANCE_STATUSES.includes(data.status) ? data.status : "hadir";
  const late = status === "hadir" && isLate(checkIn, settings.LATE_TIME || lateCutoff) ? 1 : 0;
  const row = {
    id: uid("ATT"),
    date,
    student_id: student.id,
    status,
    check_in_time: checkIn,
    is_late: late,
    note: String(data.note || "").trim(),
    source: String(data.source || "qr_scan").trim(),
    teacher_id: userId,
    created_at: nowIso(),
    updated_at: nowIso()
  };
  const existing = db.prepare("SELECT id, created_at FROM attendance WHERE date = ? AND student_id = ?").get(date, student.id);
  if (existing) {
    row.id = existing.id;
    row.created_at = existing.created_at;
  }
  db.prepare(
    `INSERT INTO attendance (id,date,student_id,status,check_in_time,is_late,note,source,teacher_id,created_at,updated_at)
     VALUES (@id,@date,@student_id,@status,@check_in_time,@is_late,@note,@source,@teacher_id,@created_at,@updated_at)
     ON CONFLICT(date,student_id) DO UPDATE SET
       status=excluded.status, check_in_time=excluded.check_in_time, is_late=excluded.is_late,
       note=excluded.note, source=excluded.source, teacher_id=excluded.teacher_id, updated_at=excluded.updated_at`
  ).run(row);
  return { row, student };
}

router.post("/auth/login", asyncHandler(async (req, res) => {
  const username = String(req.body.username || "").trim().toLowerCase();
  const password = String(req.body.password || "");
  if (!username || !password) {
    return res.status(400).json({ ok: false, message: "Username dan password wajib." });
  }
  const user = db
    .prepare("SELECT * FROM users WHERE (lower(username)=? OR lower(email)=?) AND is_active=1")
    .get(username, username);
  if (!user) return res.status(401).json({ ok: false, message: "User tidak ditemukan." });
  const valid = bcrypt.compareSync(password, user.password_hash);
  if (!valid) return res.status(401).json({ ok: false, message: "Password salah." });

  const token = jwt.sign({ userId: user.id, role: user.role }, jwtSecret, { expiresIn: "12h" });
  db.prepare("UPDATE users SET last_login_at = ? WHERE id = ?").run(nowIso(), user.id);
  logAudit("login", user.id, { username: user.username });
  return res.json({
    ok: true,
    data: {
      token,
      user: { id: user.id, username: user.username, full_name: user.full_name, email: user.email, role: user.role }
    }
  });
}));

router.get("/bootstrap", authRequired, asyncHandler(async (req, res) => {
  const settings = getSettingsMap();
  const students = db.prepare("SELECT * FROM students WHERE is_active=1 ORDER BY full_name").all();
  const users = req.user.role === "admin"
    ? db.prepare("SELECT id, username, full_name, email, role, wa_number, is_active FROM users ORDER BY full_name").all()
    : [];
  return res.json({
    ok: true,
    data: {
      user: req.user,
      settings,
      master: { subjects: SUBJECTS, attendance_statuses: ATTENDANCE_STATUSES },
      students,
      users
    }
  });
}));

router.get("/users", authRequired, requireRole("admin"), asyncHandler(async (req, res) => {
  const users = db.prepare("SELECT id, username, full_name, email, role, wa_number, is_active FROM users ORDER BY full_name").all();
  return res.json({ ok: true, data: users });
}));

router.post("/users", authRequired, requireRole("admin"), asyncHandler(async (req, res) => {
  const data = req.body || {};
  const id = data.id || uid("USR");
  const row = {
    id,
    username: String(data.username || "").trim().toLowerCase(),
    full_name: String(data.full_name || "").trim(),
    email: String(data.email || "").trim().toLowerCase(),
    role: data.role === "admin" ? "admin" : "teacher",
    password_hash: data.password ? bcrypt.hashSync(data.password, 10) : null,
    wa_number: normalizePhone(data.wa_number || ""),
    is_active: data.is_active === false ? 0 : 1,
    created_at: nowIso()
  };
  if (!row.username || !row.full_name) return res.status(400).json({ ok: false, message: "username/full_name wajib." });
  if (!row.password_hash) row.password_hash = bcrypt.hashSync("123456", 10);
  db.prepare(
    `INSERT INTO users (id, username, full_name, email, role, password_hash, wa_number, is_active, created_at)
     VALUES (@id,@username,@full_name,@email,@role,@password_hash,@wa_number,@is_active,@created_at)
     ON CONFLICT(id) DO UPDATE SET
       username=excluded.username, full_name=excluded.full_name, email=excluded.email,
       role=excluded.role, wa_number=excluded.wa_number, is_active=excluded.is_active`
  ).run(row);
  logAudit("upsert_user", req.user.id, { target: id });
  return res.json({ ok: true, data: { id } });
}));

router.get("/students", authRequired, asyncHandler(async (req, res) => {
  const query = String(req.query.query || "").trim().toLowerCase();
  const rows = db.prepare("SELECT * FROM students WHERE is_active=1 ORDER BY full_name").all();
  const filtered = query
    ? rows.filter((s) => s.full_name.toLowerCase().includes(query) || String(s.nisn || "").toLowerCase().includes(query))
    : rows;
  return res.json({ ok: true, data: filtered });
}));

router.post("/students", authRequired, requireRole("admin"), asyncHandler(async (req, res) => {
  const data = req.body || {};
  const id = data.id || uid("STU");
  const row = {
    id,
    nisn: String(data.nisn || "").trim(),
    full_name: String(data.full_name || "").trim(),
    class_name: String(data.class_name || "Kelas 4").trim(),
    gender: String(data.gender || "").trim(),
    parent_name: String(data.parent_name || "").trim(),
    parent_wa: normalizePhone(data.parent_wa || ""),
    is_active: data.is_active === false ? 0 : 1,
    qr_token: String(data.qr_token || uid("QR").replace("QR-", "")).trim(),
    created_at: nowIso(),
    updated_at: nowIso()
  };
  if (!row.full_name) return res.status(400).json({ ok: false, message: "Nama siswa wajib." });
  db.prepare(
    `INSERT INTO students (id, nisn, full_name, class_name, gender, parent_name, parent_wa, is_active, qr_token, created_at, updated_at)
     VALUES (@id,@nisn,@full_name,@class_name,@gender,@parent_name,@parent_wa,@is_active,@qr_token,@created_at,@updated_at)
     ON CONFLICT(id) DO UPDATE SET
       nisn=excluded.nisn, full_name=excluded.full_name, class_name=excluded.class_name, gender=excluded.gender,
       parent_name=excluded.parent_name, parent_wa=excluded.parent_wa, is_active=excluded.is_active, qr_token=excluded.qr_token,
       updated_at=excluded.updated_at`
  ).run(row);
  logAudit("upsert_student", req.user.id, { student_id: id });
  return res.json({ ok: true, data: row });
}));

router.get("/students/:id/qr", authRequired, asyncHandler(async (req, res) => {
  const student = getStudentById(req.params.id);
  if (!student) return res.status(404).json({ ok: false, message: "Siswa tidak ditemukan." });
  let token = student.qr_token;
  if (!token) {
    token = uid("QR").replace("QR-", "");
    db.prepare("UPDATE students SET qr_token = ?, updated_at = ? WHERE id = ?").run(token, nowIso(), student.id);
  }
  const qrPayload = `STU|${student.id}|${token}`;
  const imageDataUrl = await QRCode.toDataURL(qrPayload);
  return res.json({ ok: true, data: { student_id: student.id, full_name: student.full_name, qrPayload, imageDataUrl } });
}));

router.get("/students/qr/batch", authRequired, asyncHandler(async (req, res) => {
  const rows = db.prepare("SELECT * FROM students WHERE is_active=1 ORDER BY full_name").all();
  const payload = await Promise.all(rows.map(async (student) => {
    const token = student.qr_token || uid("QR").replace("QR-", "");
    if (!student.qr_token) db.prepare("UPDATE students SET qr_token=?, updated_at=? WHERE id=?").run(token, nowIso(), student.id);
    const qrPayload = `STU|${student.id}|${token}`;
    return { student_id: student.id, full_name: student.full_name, class_name: student.class_name, qrPayload, imageDataUrl: await QRCode.toDataURL(qrPayload) };
  }));
  return res.json({ ok: true, data: payload });
}));

router.post("/attendance/scan", authRequired, asyncHandler(async (req, res) => {
  const data = req.body || {};
  const { row, student } = await upsertAttendanceRecord({ userId: req.user.id, data });
  const wa = data.notify_parent === false ? { sent: false, reason: "Skipped by request." } : await sendAttendanceNotification(student, row);
  logAudit("attendance_scan", req.user.id, { student_id: student.id, date: row.date, status: row.status, late: !!row.is_late, wa_sent: !!wa.sent });
  return res.json({ ok: true, data: { attendance: row, waResult: wa } });
}));

router.post("/attendance/manual", authRequired, asyncHandler(async (req, res) => {
  const data = { ...(req.body || {}), source: "manual", notify_parent: false };
  const { row } = await upsertAttendanceRecord({ userId: req.user.id, data });
  return res.json({ ok: true, data: { attendance: row, waResult: { sent: false, reason: "Manual mode." } } });
}));

router.get("/attendance", authRequired, asyncHandler(async (req, res) => {
  const date = String(req.query.date || "").trim();
  const month = String(req.query.month || "").trim().padStart(2, "0");
  const year = String(req.query.year || "").trim();
  const status = String(req.query.status || "").trim();
  const query = String(req.query.query || "").trim().toLowerCase();

  let sql = `
    SELECT a.*, s.full_name AS student_name, u.full_name AS teacher_name
    FROM attendance a
    JOIN students s ON s.id = a.student_id
    JOIN users u ON u.id = a.teacher_id
    WHERE 1=1`;
  const args = [];
  if (date) { sql += " AND a.date = ?"; args.push(date); }
  if (month && year) { sql += " AND strftime('%m', a.date)=? AND strftime('%Y', a.date)=?"; args.push(month, year); }
  if (status) { sql += " AND a.status = ?"; args.push(status); }
  sql += " ORDER BY a.date DESC, a.check_in_time DESC";
  let rows = db.prepare(sql).all(...args);
  if (query) rows = rows.filter((r) => String(r.student_name || "").toLowerCase().includes(query));
  return res.json({ ok: true, data: rows });
}));

router.get("/attendance/recap", authRequired, asyncHandler(async (req, res) => {
  const today = dateKey();
  const date = String(req.query.date || today).trim();
  const current = new Date();
  const month = Number(req.query.month || current.getMonth() + 1);
  const year = Number(req.query.year || current.getFullYear());
  const totalStudents = db.prepare("SELECT COUNT(*) as n FROM students WHERE is_active=1").get().n;
  return res.json({
    ok: true,
    data: {
      daily: buildDailyRecap(date, totalStudents),
      monthly: buildMonthlyRecap(month, year, totalStudents)
    }
  });
}));

router.post("/grades", authRequired, asyncHandler(async (req, res) => {
  const data = req.body || {};
  if (!SUBJECTS.includes(String(data.subject || ""))) {
    return res.status(400).json({ ok: false, message: "Mata pelajaran tidak valid." });
  }
  const id = data.id || uid("GRD");
  const row = {
    id,
    student_id: String(data.student_id || "").trim(),
    subject: String(data.subject || "").trim(),
    objective_code: String(data.objective_code || uid("TP")).trim(),
    objective_text: String(data.objective_text || "").trim(),
    nilai_harian: clampScore(data.nilai_harian),
    nilai_tugas: clampScore(data.nilai_tugas),
    nilai_pts: clampScore(data.nilai_pts),
    nilai_pas: clampScore(data.nilai_pas),
    nilai_sikap: clampScore(data.nilai_sikap),
    nilai_produk: clampScore(data.nilai_produk),
    semester: String(data.semester || "Genap").trim(),
    academic_year: String(data.academic_year || academicYearNow()).trim(),
    teacher_id: req.user.id,
    created_at: nowIso(),
    updated_at: nowIso()
  };
  if (!row.student_id) return res.status(400).json({ ok: false, message: "student_id wajib." });
  const calc = calculateFinalScore(row);
  row.final_score = calc.finalScore;
  row.predicate = calc.predicate;
  const existing = db
    .prepare("SELECT id, created_at FROM grades WHERE student_id=? AND subject=? AND objective_code=? AND semester=? AND academic_year=?")
    .get(row.student_id, row.subject, row.objective_code, row.semester, row.academic_year);
  if (existing) {
    row.id = existing.id;
    row.created_at = existing.created_at;
  }
  db.prepare(
    `INSERT INTO grades (id,student_id,subject,objective_code,objective_text,nilai_harian,nilai_tugas,nilai_pts,nilai_pas,nilai_sikap,nilai_produk,final_score,predicate,semester,academic_year,teacher_id,created_at,updated_at)
     VALUES (@id,@student_id,@subject,@objective_code,@objective_text,@nilai_harian,@nilai_tugas,@nilai_pts,@nilai_pas,@nilai_sikap,@nilai_produk,@final_score,@predicate,@semester,@academic_year,@teacher_id,@created_at,@updated_at)
     ON CONFLICT(student_id,subject,objective_code,semester,academic_year) DO UPDATE SET
       objective_text=excluded.objective_text, nilai_harian=excluded.nilai_harian, nilai_tugas=excluded.nilai_tugas, nilai_pts=excluded.nilai_pts, nilai_pas=excluded.nilai_pas,
       nilai_sikap=excluded.nilai_sikap, nilai_produk=excluded.nilai_produk, final_score=excluded.final_score, predicate=excluded.predicate,
       teacher_id=excluded.teacher_id, updated_at=excluded.updated_at`
  ).run(row);
  logAudit("save_grade", req.user.id, { id: row.id, student_id: row.student_id, subject: row.subject });
  return res.json({ ok: true, data: row });
}));

router.get("/grades", authRequired, asyncHandler(async (req, res) => {
  let sql = `
    SELECT g.*, s.full_name AS student_name
    FROM grades g JOIN students s ON s.id = g.student_id
    WHERE 1=1`;
  const args = [];
  if (req.query.subject) { sql += " AND g.subject = ?"; args.push(req.query.subject); }
  if (req.query.semester) { sql += " AND g.semester = ?"; args.push(req.query.semester); }
  if (req.query.academic_year) { sql += " AND g.academic_year = ?"; args.push(req.query.academic_year); }
  sql += " ORDER BY g.updated_at DESC";
  const rows = db.prepare(sql).all(...args);
  return res.json({ ok: true, data: rows });
}));

router.get("/grades/export.csv", authRequired, asyncHandler(async (req, res) => {
  const rows = db.prepare(`
    SELECT g.*, s.full_name AS student_name
    FROM grades g JOIN students s ON s.id = g.student_id
    ORDER BY g.updated_at DESC
  `).all();
  const headers = ["student_id", "student_name", "subject", "objective_code", "objective_text", "nilai_harian", "nilai_tugas", "nilai_pts", "nilai_pas", "nilai_sikap", "nilai_produk", "final_score", "predicate", "semester", "academic_year", "updated_at"];
  const csv = [headers.join(",")]
    .concat(rows.map((row) => headers.map((h) => `"${String(row[h] ?? "").replace(/"/g, '""')}"`).join(",")))
    .join("\n");
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", "attachment; filename=grades-export.csv");
  return res.send(csv);
}));

router.post("/journals", authRequired, asyncHandler(async (req, res) => {
  const data = req.body || {};
  const row = {
    id: uid("JRN"),
    tanggal: String(data.tanggal || dateKey()).trim(),
    mata_pelajaran: String(data.mata_pelajaran || "").trim(),
    tujuan_pembelajaran: String(data.tujuan_pembelajaran || "").trim(),
    materi: String(data.materi || "").trim(),
    kendala: String(data.kendala || "").trim(),
    jam_waktu: String(data.jam_waktu || "").trim(),
    teacher_id: req.user.id,
    created_at: nowIso()
  };
  if (!row.mata_pelajaran) return res.status(400).json({ ok: false, message: "Mata pelajaran wajib." });
  db.prepare("INSERT INTO journals (id,tanggal,mata_pelajaran,tujuan_pembelajaran,materi,kendala,jam_waktu,teacher_id,created_at) VALUES (@id,@tanggal,@mata_pelajaran,@tujuan_pembelajaran,@materi,@kendala,@jam_waktu,@teacher_id,@created_at)").run(row);
  return res.json({ ok: true, data: row });
}));

router.get("/journals", authRequired, asyncHandler(async (req, res) => {
  let sql = `
    SELECT j.*, u.full_name AS teacher_name
    FROM journals j JOIN users u ON u.id = j.teacher_id
    WHERE 1=1`;
  const args = [];
  if (req.query.tanggal) { sql += " AND j.tanggal = ?"; args.push(req.query.tanggal); }
  if (req.query.mata_pelajaran) { sql += " AND j.mata_pelajaran = ?"; args.push(req.query.mata_pelajaran); }
  sql += " ORDER BY j.created_at DESC";
  return res.json({ ok: true, data: db.prepare(sql).all(...args) });
}));

router.post("/counselings", authRequired, asyncHandler(async (req, res) => {
  const data = req.body || {};
  const student = getStudentById(String(data.student_id || "").trim());
  if (!student) return res.status(404).json({ ok: false, message: "Siswa tidak ditemukan." });
  const row = {
    id: uid("CSL"),
    tanggal: String(data.tanggal || dateKey()).trim(),
    student_id: student.id,
    violation_type: String(data.violation_type || "").trim(),
    handling: String(data.handling || "").trim(),
    follow_up: String(data.follow_up || "").trim(),
    result: String(data.result || "").trim(),
    teacher_id: req.user.id,
    parent_notified: 0,
    created_at: nowIso()
  };
  if (!row.violation_type) return res.status(400).json({ ok: false, message: "Jenis pelanggaran wajib." });
  db.prepare("INSERT INTO counseling (id,tanggal,student_id,violation_type,handling,follow_up,result,teacher_id,parent_notified,created_at) VALUES (@id,@tanggal,@student_id,@violation_type,@handling,@follow_up,@result,@teacher_id,@parent_notified,@created_at)").run(row);
  let waResult = { sent: false, reason: "Skipped." };
  if (data.notify_parent !== false) {
    waResult = await sendCounselingNotification(student, row);
    if (waResult.sent) {
      db.prepare("UPDATE counseling SET parent_notified=1 WHERE id=?").run(row.id);
      row.parent_notified = 1;
    }
  }
  return res.json({ ok: true, data: { record: row, waResult } });
}));

router.get("/counselings", authRequired, asyncHandler(async (req, res) => {
  let sql = `
    SELECT c.*, s.full_name AS student_name, u.full_name AS teacher_name
    FROM counseling c
    JOIN students s ON s.id = c.student_id
    JOIN users u ON u.id = c.teacher_id
    WHERE 1=1`;
  const args = [];
  if (req.query.tanggal) { sql += " AND c.tanggal = ?"; args.push(req.query.tanggal); }
  if (req.query.student_id) { sql += " AND c.student_id = ?"; args.push(req.query.student_id); }
  sql += " ORDER BY c.created_at DESC";
  return res.json({ ok: true, data: db.prepare(sql).all(...args) });
}));

router.get("/dashboard/analytics", authRequired, asyncHandler(async (req, res) => {
  const today = dateKey();
  const now = new Date();
  const totalStudents = db.prepare("SELECT COUNT(*) as n FROM students WHERE is_active=1").get().n;
  const attendanceToday = buildDailyRecap(today, totalStudents);
  const monthly = buildMonthlyRecap(now.getMonth() + 1, now.getFullYear(), totalStudents);
  const gradeAverageBySubject = SUBJECTS.reduce((acc, subject) => {
    const row = db.prepare("SELECT AVG(final_score) as avg FROM grades WHERE subject = ?").get(subject);
    acc[subject] = row.avg ? Math.round(row.avg * 100) / 100 : 0;
    return acc;
  }, {});
  const topViolations = db
    .prepare("SELECT violation_type, COUNT(*) as count FROM counseling GROUP BY violation_type ORDER BY count DESC LIMIT 5")
    .all();

  return res.json({
    ok: true,
    data: {
      studentsTotal: totalStudents,
      attendanceToday,
      attendanceMonthly: monthly,
      gradeAverageBySubject,
      topViolations
    }
  });
}));

router.post("/offline/sync", authRequired, asyncHandler(async (req, res) => {
  const actions = Array.isArray(req.body.actions) ? req.body.actions : [];
  const results = [];
  for (const action of actions) {
    try {
      const type = String(action.type || "");
      const data = action.data || {};
      if (type === "attendance_scan") {
        await upsertAttendanceRecord({ userId: req.user.id, data });
      } else if (type === "attendance_manual") {
        await upsertAttendanceRecord({ userId: req.user.id, data: { ...data, source: "manual", notify_parent: false } });
      } else if (type === "grade_save") {
        const p = { ...data, teacher_id: req.user.id, created_at: nowIso(), updated_at: nowIso(), id: data.id || uid("GRD") };
        const calc = calculateFinalScore(p);
        p.final_score = calc.finalScore;
        p.predicate = calc.predicate;
        db.prepare(
          `INSERT INTO grades (id,student_id,subject,objective_code,objective_text,nilai_harian,nilai_tugas,nilai_pts,nilai_pas,nilai_sikap,nilai_produk,final_score,predicate,semester,academic_year,teacher_id,created_at,updated_at)
           VALUES (@id,@student_id,@subject,@objective_code,@objective_text,@nilai_harian,@nilai_tugas,@nilai_pts,@nilai_pas,@nilai_sikap,@nilai_produk,@final_score,@predicate,@semester,@academic_year,@teacher_id,@created_at,@updated_at)
           ON CONFLICT(student_id,subject,objective_code,semester,academic_year) DO UPDATE SET
             objective_text=excluded.objective_text, nilai_harian=excluded.nilai_harian, nilai_tugas=excluded.nilai_tugas, nilai_pts=excluded.nilai_pts, nilai_pas=excluded.nilai_pas,
             nilai_sikap=excluded.nilai_sikap, nilai_produk=excluded.nilai_produk, final_score=excluded.final_score, predicate=excluded.predicate,
             teacher_id=excluded.teacher_id, updated_at=excluded.updated_at`
        ).run(p);
      } else if (type === "journal_save") {
        await db.prepare("INSERT INTO journals (id,tanggal,mata_pelajaran,tujuan_pembelajaran,materi,kendala,jam_waktu,teacher_id,created_at) VALUES (?,?,?,?,?,?,?,?,?)")
          .run(uid("JRN"), data.tanggal || dateKey(), data.mata_pelajaran || "", data.tujuan_pembelajaran || "", data.materi || "", data.kendala || "", data.jam_waktu || "", req.user.id, nowIso());
      } else if (type === "counseling_save") {
        await db.prepare("INSERT INTO counseling (id,tanggal,student_id,violation_type,handling,follow_up,result,teacher_id,parent_notified,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
          .run(uid("CSL"), data.tanggal || dateKey(), data.student_id || "", data.violation_type || "", data.handling || "", data.follow_up || "", data.result || "", req.user.id, 0, nowIso());
      }
      results.push({ actionId: action.actionId, success: true });
    } catch (error) {
      results.push({ actionId: action.actionId, success: false, error: error.message });
    }
  }
  return res.json({ ok: true, data: { processed: actions.length, results } });
}));

router.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  return res.status(500).json({ ok: false, message: error.message || "Internal server error." });
});

module.exports = router;
