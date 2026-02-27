const crypto = require("crypto");
const dayjs = require("dayjs");

const SUBJECTS = ["Matematika", "IPAS", "Bahasa Indonesia", "Bahasa Bali", "SBdP"];
const ATTENDANCE_STATUSES = ["hadir", "sakit", "izin", "alfa"];

function uid(prefix) {
  return `${prefix}-${crypto.randomBytes(4).toString("hex").toUpperCase()}`;
}

function nowIso() {
  return new Date().toISOString();
}

function dateKey(date = new Date()) {
  return dayjs(date).format("YYYY-MM-DD");
}

function timeKey(date = new Date()) {
  return dayjs(date).format("HH:mm:ss");
}

function normalizePhone(input = "") {
  let raw = String(input).replace(/[^\d+]/g, "");
  if (!raw) return "";
  if (raw.startsWith("+")) raw = raw.slice(1);
  if (raw.startsWith("0")) raw = `62${raw.slice(1)}`;
  if (!raw.startsWith("62")) raw = `62${raw}`;
  return raw;
}

function parseMinutes(hhmm = "00:00") {
  const [h = "0", m = "0"] = String(hhmm).split(":");
  return Number(h) * 60 + Number(m);
}

function isLate(checkInTime, cutoff) {
  return parseMinutes(checkInTime) > parseMinutes(cutoff);
}

function clampScore(v) {
  let n = Number(v || 0);
  if (Number.isNaN(n)) n = 0;
  if (n < 0) n = 0;
  if (n > 100) n = 100;
  return Math.round(n * 100) / 100;
}

function scorePredicate(score) {
  if (score >= 90) return "A";
  if (score >= 80) return "B";
  if (score >= 70) return "C";
  return "D";
}

function academicYearNow() {
  const now = dayjs();
  const year = now.year();
  return now.month() + 1 >= 7 ? `${year}/${year + 1}` : `${year - 1}/${year}`;
}

function safeJsonParse(value, fallback) {
  try {
    return JSON.parse(value);
  } catch (e) {
    return fallback;
  }
}

module.exports = {
  SUBJECTS,
  ATTENDANCE_STATUSES,
  uid,
  nowIso,
  dateKey,
  timeKey,
  normalizePhone,
  isLate,
  clampScore,
  scorePredicate,
  academicYearNow,
  safeJsonParse
};
