/**
 * Sistem Administrasi Kelas SD
 * Backend Google Apps Script
 *
 * Cara pakai:
 * 1) Isi Script Properties:
 *    - SPREADSHEET_ID
 *    - WHATSAPP_API_URL (opsional)
 *    - WHATSAPP_API_TOKEN (opsional)
 *    - WHATSAPP_SENDER (opsional)
 * 2) Jalankan setupSystem() sekali dari Apps Script editor.
 * 3) Deploy sebagai Web App.
 */

var APP_CONFIG = {
  APP_NAME: "Administrasi Kelas SD",
  TIMEZONE: "Asia/Makassar",
  SESSION_TTL_SECONDS: 60 * 60 * 12,
  ATTENDANCE_CUTOFF_DEFAULT: "07:30",
  ATTENDANCE_STATUSES: ["hadir", "sakit", "izin", "alfa"],
  SUBJECTS: [
    "Matematika",
    "IPAS",
    "Bahasa Indonesia",
    "Bahasa Bali",
    "SBdP"
  ],
  SHEETS: {
    USERS: "Users",
    STUDENTS: "Students",
    ATTENDANCE: "Attendance",
    ATTENDANCE_RECAP_DAILY: "AttendanceRecapDaily",
    GRADES: "Grades",
    JOURNAL: "Journal",
    COUNSELING: "Counseling",
    SETTINGS: "Settings",
    AUDIT_LOG: "AuditLog"
  },
  CACHE_KEYS: {
    SETTINGS: "app_settings_v1",
    STUDENTS: "students_all_v1",
    USERS: "users_all_v1"
  }
};

var SHEET_HEADERS = {
  Users: [
    "user_id",
    "username",
    "full_name",
    "email",
    "role",
    "password_hash",
    "wa_number",
    "is_active",
    "last_login_at",
    "created_at",
    "updated_at"
  ],
  Students: [
    "student_id",
    "nisn",
    "full_name",
    "class_name",
    "gender",
    "parent_name",
    "parent_wa",
    "is_active",
    "qr_token",
    "created_at",
    "updated_at"
  ],
  Attendance: [
    "attendance_id",
    "date",
    "student_id",
    "status",
    "check_in_time",
    "is_late",
    "note",
    "source",
    "teacher_id",
    "created_at",
    "updated_at"
  ],
  AttendanceRecapDaily: [
    "date",
    "total_students",
    "hadir",
    "sakit",
    "izin",
    "alfa",
    "late_count",
    "present_rate",
    "updated_at"
  ],
  Grades: [
    "grade_id",
    "student_id",
    "subject",
    "objective_code",
    "objective_text",
    "nilai_harian",
    "nilai_tugas",
    "nilai_pts",
    "nilai_pas",
    "nilai_sikap",
    "nilai_produk",
    "final_score",
    "predicate",
    "semester",
    "academic_year",
    "teacher_id",
    "created_at",
    "updated_at"
  ],
  Journal: [
    "journal_id",
    "tanggal",
    "mata_pelajaran",
    "tujuan_pembelajaran",
    "materi",
    "kendala",
    "jam_waktu",
    "teacher_id",
    "created_at"
  ],
  Counseling: [
    "counseling_id",
    "tanggal",
    "student_id",
    "violation_type",
    "handling",
    "follow_up",
    "result",
    "teacher_id",
    "parent_notified",
    "created_at"
  ],
  Settings: ["key", "value", "updated_at"],
  AuditLog: ["log_id", "event_type", "user_id", "payload_json", "created_at"]
};

function doGet() {
  return HtmlService.createTemplateFromFile("Index")
    .evaluate()
    .setTitle(APP_CONFIG.APP_NAME)
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

function setupSystem() {
  return withGuard_("setupSystem", function () {
    var ss = getDb_();
    ensureAllSheets_(ss);
    seedSettings_();
    seedDefaultUsers_();
    return {
      spreadsheetId: ss.getId(),
      spreadsheetUrl: ss.getUrl(),
      message: "Setup selesai"
    };
  });
}

function hashPassword(rawPassword) {
  return hashPassword_(rawPassword);
}

function loginUser(payload) {
  return withGuard_("loginUser", function () {
    payload = payload || {};
    var username = normalizeText_(payload.username).toLowerCase();
    var password = String(payload.password || "");
    if (!username || !password) {
      throw new Error("Username dan password wajib diisi.");
    }

    var users = listUsersInternal_({ activeOnly: true });
    var user = users.find(function (u) {
      return (
        String(u.username || "").toLowerCase() === username ||
        String(u.email || "").toLowerCase() === username
      );
    });
    if (!user) throw new Error("User tidak ditemukan.");

    var computedHash = hashPassword_(password);
    if (computedHash !== user.password_hash) throw new Error("Password salah.");
    if (!toBool_(user.is_active)) throw new Error("Akun tidak aktif.");

    var sessionToken = createSession_(user);
    updateUserLoginTime_(user.user_id);
    logAudit_("login", user.user_id, { username: user.username });
    return { sessionToken: sessionToken, user: pickPublicUser_(user) };
  });
}

function logoutUser(payload) {
  return withGuard_("logoutUser", function () {
    payload = payload || {};
    clearSession_(String(payload.sessionToken || ""));
    return { success: true };
  });
}

function getAppBootstrap(payload) {
  return withGuard_("getAppBootstrap", function () {
    var session = requireSession_(payload && payload.sessionToken);
    var settings = getSettingsMap_();
    var students = listStudentsInternal_({ activeOnly: true });
    var analytics = getDashboardAnalyticsInternal_(session.user);
    var result = {
      user: session.user,
      settings: settings,
      master: {
        attendanceStatuses: APP_CONFIG.ATTENDANCE_STATUSES,
        subjects: APP_CONFIG.SUBJECTS
      },
      students: students.map(pickPublicStudent_),
      analytics: analytics,
      now: isoNow_()
    };
    if (session.user.role === "admin") {
      result.users = listUsersInternal_({ activeOnly: false }).map(pickPublicUser_);
    }
    return result;
  });
}

function listUsers(payload) {
  return withGuard_("listUsers", function () {
    var session = requireRole_(payload && payload.sessionToken, ["admin"]);
    var users = listUsersInternal_({ activeOnly: false }).map(pickPublicUser_);
    logAudit_("list_users", session.user.user_id, { count: users.length });
    return users;
  });
}

function upsertUser(payload) {
  return withGuard_("upsertUser", function () {
    payload = payload || {};
    var session = requireRole_(payload.sessionToken, ["admin"]);
    var data = payload.data || {};

    var userId = normalizeText_(data.user_id) || "USR-" + shortId_();
    var username = normalizeText_(data.username).toLowerCase();
    var role = normalizeText_(data.role || "teacher").toLowerCase();
    if (!username) throw new Error("Username wajib diisi.");
    if (["admin", "teacher"].indexOf(role) < 0) throw new Error("Role tidak valid.");

    var existingUsers = listUsersInternal_({ activeOnly: false });
    var duplicate = existingUsers.find(function (u) {
      return u.user_id !== userId && String(u.username || "").toLowerCase() === username;
    });
    if (duplicate) throw new Error("Username sudah digunakan.");

    var now = isoNow_();
    var row = {
      user_id: userId,
      username: username,
      full_name: normalizeText_(data.full_name),
      email: normalizeText_(data.email).toLowerCase(),
      role: role,
      password_hash: normalizeText_(data.password)
        ? hashPassword_(data.password)
        : normalizeText_(data.password_hash),
      wa_number: normalizePhone_(data.wa_number),
      is_active: toBool_(data.is_active),
      last_login_at: normalizeText_(data.last_login_at),
      created_at: normalizeText_(data.created_at) || now,
      updated_at: now
    };
    if (!row.password_hash) row.password_hash = hashPassword_("123456");

    upsertById_(APP_CONFIG.SHEETS.USERS, "user_id", row);
    clearUsersCache_();
    logAudit_("upsert_user", session.user.user_id, { target_user_id: userId });
    return pickPublicUser_(row);
  });
}

function listStudents(payload) {
  return withGuard_("listStudents", function () {
    var session = requireRole_(payload && payload.sessionToken, ["admin", "teacher"]);
    var params = payload || {};
    var students = listStudentsInternal_({ activeOnly: params.activeOnly !== false });
    var query = normalizeText_(params.query).toLowerCase();
    if (query) {
      students = students.filter(function (s) {
        return (
          String(s.full_name || "").toLowerCase().indexOf(query) >= 0 ||
          String(s.nisn || "").toLowerCase().indexOf(query) >= 0 ||
          String(s.student_id || "").toLowerCase().indexOf(query) >= 0
        );
      });
    }
    logAudit_("list_students", session.user.user_id, { count: students.length });
    return students.map(pickPublicStudent_);
  });
}

function upsertStudent(payload) {
  return withGuard_("upsertStudent", function () {
    payload = payload || {};
    var session = requireRole_(payload.sessionToken, ["admin"]);
    var data = payload.data || {};
    var studentId = normalizeText_(data.student_id) || "STU-" + shortId_();
    var now = isoNow_();
    var row = {
      student_id: studentId,
      nisn: normalizeText_(data.nisn),
      full_name: normalizeText_(data.full_name),
      class_name: normalizeText_(data.class_name || "Kelas 4"),
      gender: normalizeText_(data.gender),
      parent_name: normalizeText_(data.parent_name),
      parent_wa: normalizePhone_(data.parent_wa),
      is_active: toBool_(data.is_active !== false),
      qr_token: normalizeText_(data.qr_token),
      created_at: normalizeText_(data.created_at) || now,
      updated_at: now
    };
    if (!row.full_name) throw new Error("Nama siswa wajib diisi.");
    if (!row.qr_token) row.qr_token = shortId_() + shortId_();

    upsertById_(APP_CONFIG.SHEETS.STUDENTS, "student_id", row);
    clearStudentsCache_();
    logAudit_("upsert_student", session.user.user_id, { student_id: studentId });
    return pickPublicStudent_(row);
  });
}

function generateStudentQr(payload) {
  return withGuard_("generateStudentQr", function () {
    payload = payload || {};
    var session = requireRole_(payload.sessionToken, ["admin", "teacher"]);
    var studentId = normalizeText_(payload.student_id);
    if (!studentId) throw new Error("student_id wajib.");
    var student = findStudentById_(studentId);
    if (!student) throw new Error("Siswa tidak ditemukan.");

    if (!student.qr_token || payload.forceRegenerate) {
      student.qr_token = shortId_() + shortId_();
      student.updated_at = isoNow_();
      upsertById_(APP_CONFIG.SHEETS.STUDENTS, "student_id", student);
      clearStudentsCache_();
    }
    var qrPayload = buildStudentQrPayload_(student);
    logAudit_("generate_qr", session.user.user_id, { student_id: studentId });
    return {
      student: pickPublicStudent_(student),
      qrPayload: qrPayload,
      qrImageUrl:
        "https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=" +
        encodeURIComponent(qrPayload)
    };
  });
}

function getStudentQrBatch(payload) {
  return withGuard_("getStudentQrBatch", function () {
    var session = requireRole_(payload && payload.sessionToken, ["admin", "teacher"]);
    var students = listStudentsInternal_({ activeOnly: true }).map(function (s) {
      if (!s.qr_token) {
        s.qr_token = shortId_() + shortId_();
        s.updated_at = isoNow_();
        upsertById_(APP_CONFIG.SHEETS.STUDENTS, "student_id", s);
      }
      var qrPayload = buildStudentQrPayload_(s);
      return {
        student_id: s.student_id,
        full_name: s.full_name,
        class_name: s.class_name,
        qrPayload: qrPayload,
        qrImageUrl:
          "https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=" +
          encodeURIComponent(qrPayload)
      };
    });
    clearStudentsCache_();
    logAudit_("qr_batch", session.user.user_id, { count: students.length });
    return students;
  });
}

function scanAttendance(payload) {
  return withGuard_("scanAttendance", function () {
    payload = payload || {};
    var session = requireRole_(payload.sessionToken, ["admin", "teacher"]);
    return scanAttendanceInternal_(session.user, payload, { notifyParent: true });
  });
}

function upsertAttendanceManual(payload) {
  return withGuard_("upsertAttendanceManual", function () {
    payload = payload || {};
    var session = requireRole_(payload.sessionToken, ["admin", "teacher"]);
    var data = payload.data || {};
    data.source = "manual";
    return scanAttendanceInternal_(session.user, data, {
      notifyParent: payload.notifyParent === true
    });
  });
}

function listAttendance(payload) {
  return withGuard_("listAttendance", function () {
    payload = payload || {};
    requireRole_(payload.sessionToken, ["admin", "teacher"]);
    var rows = readObjects_(APP_CONFIG.SHEETS.ATTENDANCE);
    var studentsMap = buildMapBy_(listStudentsInternal_({ activeOnly: false }), "student_id");
    var usersMap = buildMapBy_(listUsersInternal_({ activeOnly: false }), "user_id");
    rows = rows.filter(function (r) {
      if (normalizeText_(payload.date) && r.date !== payload.date) return false;
      if (normalizeText_(payload.student_id) && r.student_id !== payload.student_id) return false;
      if (normalizeText_(payload.status) && r.status !== payload.status) return false;
      if (payload.month && payload.year) {
        var parts = String(r.date || "").split("-");
        if (parts.length !== 3) return false;
        if (Number(parts[1]) !== Number(payload.month)) return false;
        if (Number(parts[0]) !== Number(payload.year)) return false;
      }
      return true;
    });
    rows.sort(function (a, b) {
      var ka = String(a.date || "") + " " + String(a.check_in_time || "");
      var kb = String(b.date || "") + " " + String(b.check_in_time || "");
      return ka < kb ? 1 : -1;
    });
    return rows.map(function (r) {
      var student = studentsMap[r.student_id] || {};
      var teacher = usersMap[r.teacher_id] || {};
      return {
        attendance_id: r.attendance_id,
        date: r.date,
        student_id: r.student_id,
        student_name: student.full_name || "-",
        status: r.status,
        check_in_time: r.check_in_time,
        is_late: toBool_(r.is_late),
        note: r.note,
        source: r.source,
        teacher_name: teacher.full_name || "-"
      };
    });
  });
}

function getAttendanceRecap(payload) {
  return withGuard_("getAttendanceRecap", function () {
    payload = payload || {};
    requireRole_(payload.sessionToken, ["admin", "teacher"]);
    var rows = readObjects_(APP_CONFIG.SHEETS.ATTENDANCE);
    var dateKey = normalizeText_(payload.date) || dateKey_(new Date());
    var month = Number(payload.month || dateKey.split("-")[1]);
    var year = Number(payload.year || dateKey.split("-")[0]);
    var studentsCount = listStudentsInternal_({ activeOnly: true }).length;
    return {
      daily: buildDailyRecap_(rows, dateKey, studentsCount),
      monthly: buildMonthlyRecap_(rows, month, year, studentsCount)
    };
  });
}

function refreshDailyRecap(payload) {
  return withGuard_("refreshDailyRecap", function () {
    payload = payload || {};
    var session = requireRole_(payload.sessionToken, ["admin", "teacher"]);
    var dateKey = normalizeText_(payload.date) || dateKey_(new Date());
    var recap = refreshDailyRecapForDate_(dateKey);
    logAudit_("refresh_daily_recap", session.user.user_id, { date: dateKey });
    return recap;
  });
}

function dailyRecapTrigger() {
  var today = dateKey_(new Date());
  refreshDailyRecapForDate_(today);
}

function saveGrade(payload) {
  return withGuard_("saveGrade", function () {
    payload = payload || {};
    var session = requireRole_(payload.sessionToken, ["admin", "teacher"]);
    var data = payload.data || {};
    var row = normalizeGradeRow_(data, session.user.user_id);
    upsertGrade_(row);
    logAudit_("save_grade", session.user.user_id, {
      student_id: row.student_id,
      subject: row.subject
    });
    return row;
  });
}

function listGrades(payload) {
  return withGuard_("listGrades", function () {
    payload = payload || {};
    requireRole_(payload.sessionToken, ["admin", "teacher"]);
    var studentsMap = buildMapBy_(listStudentsInternal_({ activeOnly: false }), "student_id");
    var rows = readObjects_(APP_CONFIG.SHEETS.GRADES).filter(function (r) {
      if (normalizeText_(payload.student_id) && r.student_id !== payload.student_id) return false;
      if (normalizeText_(payload.subject) && r.subject !== payload.subject) return false;
      if (normalizeText_(payload.semester) && r.semester !== payload.semester) return false;
      if (normalizeText_(payload.academic_year) && r.academic_year !== payload.academic_year) return false;
      return true;
    });
    rows.sort(function (a, b) {
      return String(a.updated_at || "") < String(b.updated_at || "") ? 1 : -1;
    });
    return rows.map(function (r) {
      var student = studentsMap[r.student_id] || {};
      return {
        grade_id: r.grade_id,
        student_id: r.student_id,
        student_name: student.full_name || "-",
        subject: r.subject,
        objective_code: r.objective_code,
        objective_text: r.objective_text,
        nilai_harian: toNumber_(r.nilai_harian),
        nilai_tugas: toNumber_(r.nilai_tugas),
        nilai_pts: toNumber_(r.nilai_pts),
        nilai_pas: toNumber_(r.nilai_pas),
        nilai_sikap: toNumber_(r.nilai_sikap),
        nilai_produk: toNumber_(r.nilai_produk),
        final_score: toNumber_(r.final_score),
        predicate: r.predicate,
        semester: r.semester,
        academic_year: r.academic_year,
        updated_at: r.updated_at
      };
    });
  });
}

function exportGrades(payload) {
  return withGuard_("exportGrades", function () {
    payload = payload || {};
    var session = requireRole_(payload.sessionToken, ["admin", "teacher"]);
    var grades = listGrades({
      sessionToken: payload.sessionToken,
      subject: payload.subject,
      semester: payload.semester,
      academic_year: payload.academic_year
    }).data;
    var ss = getDb_();
    var sheetName = "ExportNilai_" + formatDate_(new Date(), "yyyyMMdd_HHmmss");
    var sh = ss.insertSheet(sheetName);
    var headers = [
      "student_id",
      "student_name",
      "subject",
      "objective_code",
      "objective_text",
      "nilai_harian",
      "nilai_tugas",
      "nilai_pts",
      "nilai_pas",
      "nilai_sikap",
      "nilai_produk",
      "final_score",
      "predicate",
      "semester",
      "academic_year",
      "updated_at"
    ];
    var values = [headers];
    grades.forEach(function (g) {
      values.push(headers.map(function (h) { return g[h]; }));
    });
    sh.getRange(1, 1, values.length, headers.length).setValues(values);
    sh.autoResizeColumns(1, headers.length);
    logAudit_("export_grades", session.user.user_id, {
      exported_rows: grades.length,
      sheet: sheetName
    });
    return {
      exportedRows: grades.length,
      sheetName: sheetName,
      sheetUrl: ss.getUrl() + "#gid=" + sh.getSheetId()
    };
  });
}

function saveJournal(payload) {
  return withGuard_("saveJournal", function () {
    payload = payload || {};
    var session = requireRole_(payload.sessionToken, ["admin", "teacher"]);
    var data = payload.data || {};
    var row = {
      journal_id: normalizeText_(data.journal_id) || "JRN-" + shortId_(),
      tanggal: normalizeText_(data.tanggal) || dateKey_(new Date()),
      mata_pelajaran: normalizeText_(data.mata_pelajaran),
      tujuan_pembelajaran: normalizeText_(data.tujuan_pembelajaran),
      materi: normalizeText_(data.materi),
      kendala: normalizeText_(data.kendala),
      jam_waktu: normalizeText_(data.jam_waktu),
      teacher_id: session.user.user_id,
      created_at: normalizeText_(data.created_at) || isoNow_()
    };
    if (!row.mata_pelajaran) throw new Error("Mata pelajaran wajib diisi.");
    appendObject_(APP_CONFIG.SHEETS.JOURNAL, row);
    logAudit_("save_journal", session.user.user_id, { journal_id: row.journal_id });
    return row;
  });
}

function listJournal(payload) {
  return withGuard_("listJournal", function () {
    payload = payload || {};
    requireRole_(payload.sessionToken, ["admin", "teacher"]);
    var usersMap = buildMapBy_(listUsersInternal_({ activeOnly: false }), "user_id");
    var rows = readObjects_(APP_CONFIG.SHEETS.JOURNAL).filter(function (r) {
      if (normalizeText_(payload.tanggal) && r.tanggal !== payload.tanggal) return false;
      if (normalizeText_(payload.mata_pelajaran) && r.mata_pelajaran !== payload.mata_pelajaran) return false;
      return true;
    });
    rows.sort(function (a, b) { return String(a.created_at) < String(b.created_at) ? 1 : -1; });
    return rows.map(function (r) {
      return {
        journal_id: r.journal_id,
        tanggal: r.tanggal,
        mata_pelajaran: r.mata_pelajaran,
        tujuan_pembelajaran: r.tujuan_pembelajaran,
        materi: r.materi,
        kendala: r.kendala,
        jam_waktu: r.jam_waktu,
        teacher_name: (usersMap[r.teacher_id] || {}).full_name || "-"
      };
    });
  });
}

function saveCounseling(payload) {
  return withGuard_("saveCounseling", function () {
    payload = payload || {};
    var session = requireRole_(payload.sessionToken, ["admin", "teacher"]);
    var data = payload.data || {};
    var student = findStudentById_(data.student_id);
    if (!student) throw new Error("Siswa tidak ditemukan.");

    var row = {
      counseling_id: normalizeText_(data.counseling_id) || "CSL-" + shortId_(),
      tanggal: normalizeText_(data.tanggal) || dateKey_(new Date()),
      student_id: student.student_id,
      violation_type: normalizeText_(data.violation_type),
      handling: normalizeText_(data.handling),
      follow_up: normalizeText_(data.follow_up),
      result: normalizeText_(data.result),
      teacher_id: session.user.user_id,
      parent_notified: false,
      created_at: isoNow_()
    };
    if (!row.violation_type) throw new Error("Jenis pelanggaran wajib diisi.");
    appendObject_(APP_CONFIG.SHEETS.COUNSELING, row);

    var notifyParent = data.notifyParent !== false;
    var waResult = { sent: false, reason: "disabled" };
    if (notifyParent) {
      waResult = sendCounselingWhatsApp_(student, row);
      row.parent_notified = !!waResult.sent;
      upsertById_(APP_CONFIG.SHEETS.COUNSELING, "counseling_id", row);
    }

    logAudit_("save_counseling", session.user.user_id, {
      counseling_id: row.counseling_id,
      student_id: student.student_id,
      wa_sent: waResult.sent
    });
    return { record: row, waResult: waResult };
  });
}

function listCounseling(payload) {
  return withGuard_("listCounseling", function () {
    payload = payload || {};
    requireRole_(payload.sessionToken, ["admin", "teacher"]);
    var studentsMap = buildMapBy_(listStudentsInternal_({ activeOnly: false }), "student_id");
    var usersMap = buildMapBy_(listUsersInternal_({ activeOnly: false }), "user_id");
    var rows = readObjects_(APP_CONFIG.SHEETS.COUNSELING).filter(function (r) {
      if (normalizeText_(payload.student_id) && r.student_id !== payload.student_id) return false;
      if (normalizeText_(payload.tanggal) && r.tanggal !== payload.tanggal) return false;
      return true;
    });
    rows.sort(function (a, b) { return String(a.created_at) < String(b.created_at) ? 1 : -1; });
    return rows.map(function (r) {
      var student = studentsMap[r.student_id] || {};
      var teacher = usersMap[r.teacher_id] || {};
      return {
        counseling_id: r.counseling_id,
        tanggal: r.tanggal,
        student_id: r.student_id,
        student_name: student.full_name || "-",
        violation_type: r.violation_type,
        handling: r.handling,
        follow_up: r.follow_up,
        result: r.result,
        teacher_name: teacher.full_name || "-",
        parent_notified: toBool_(r.parent_notified)
      };
    });
  });
}

function getDashboardAnalytics(payload) {
  return withGuard_("getDashboardAnalytics", function () {
    payload = payload || {};
    var session = requireRole_(payload.sessionToken, ["admin", "teacher"]);
    return getDashboardAnalyticsInternal_(session.user);
  });
}

function syncOfflineQueue(payload) {
  return withGuard_("syncOfflineQueue", function () {
    payload = payload || {};
    var session = requireRole_(payload.sessionToken, ["admin", "teacher"]);
    var actions = Array.isArray(payload.actions) ? payload.actions : [];
    var results = [];
    actions.forEach(function (action) {
      var type = normalizeText_(action.type);
      var data = action.data || {};
      try {
        var output;
        if (type === "attendance_scan") {
          output = scanAttendanceInternal_(session.user, data, { notifyParent: true });
        } else if (type === "attendance_manual") {
          data.source = "manual";
          output = scanAttendanceInternal_(session.user, data, { notifyParent: false });
        } else if (type === "grade_save") {
          var row = normalizeGradeRow_(data, session.user.user_id);
          upsertGrade_(row);
          output = row;
        } else if (type === "journal_save") {
          output = saveJournal({ sessionToken: payload.sessionToken, data: data }).data;
        } else if (type === "counseling_save") {
          output = saveCounseling({ sessionToken: payload.sessionToken, data: data }).data;
        } else {
          throw new Error("Tipe aksi tidak dikenal: " + type);
        }
        results.push({ actionId: action.actionId, success: true, data: output });
      } catch (err) {
        results.push({
          actionId: action.actionId,
          success: false,
          error: String(err.message || err)
        });
      }
    });
    logAudit_("sync_offline_queue", session.user.user_id, {
      total: actions.length,
      success: results.filter(function (r) { return r.success; }).length
    });
    return { processed: actions.length, results: results };
  });
}

function withGuard_(name, fn) {
  try {
    return { ok: true, data: fn() };
  } catch (err) {
    throw new Error(name + " error: " + String(err.message || err));
  }
}

function scanAttendanceInternal_(actorUser, payload, opts) {
  opts = opts || {};
  payload = payload || {};
  var student = resolveStudentFromScanPayload_(payload);
  var dateValue = normalizeText_(payload.date) || dateKey_(new Date());
  var checkInTime = normalizeText_(payload.check_in_time) || formatDate_(new Date(), "HH:mm:ss");
  var status = normalizeStatus_(payload.status || "hadir");
  var note = normalizeText_(payload.note);
  var source = normalizeText_(payload.source || "qr_scan");
  var settings = getSettingsMap_();
  var lateCutoff = settings.LATE_TIME || APP_CONFIG.ATTENDANCE_CUTOFF_DEFAULT;
  var isLate = status === "hadir" && isAfterTime_(checkInTime, lateCutoff);

  var row = {
    attendance_id: normalizeText_(payload.attendance_id) || "ATT-" + shortId_(),
    date: dateValue,
    student_id: student.student_id,
    status: status,
    check_in_time: checkInTime,
    is_late: isLate,
    note: note,
    source: source,
    teacher_id: actorUser.user_id,
    created_at: isoNow_(),
    updated_at: isoNow_()
  };

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var existed = findAttendanceByDateAndStudent_(dateValue, student.student_id);
    if (existed) {
      row.attendance_id = existed.attendance_id;
      row.created_at = existed.created_at || row.created_at;
      upsertById_(APP_CONFIG.SHEETS.ATTENDANCE, "attendance_id", row);
    } else {
      appendObject_(APP_CONFIG.SHEETS.ATTENDANCE, row);
    }
  } finally {
    lock.releaseLock();
  }

  var waResult = { sent: false, reason: "not-requested" };
  if (opts.notifyParent) {
    waResult = sendAttendanceWhatsApp_(student, row);
  }
  var recap = refreshDailyRecapForDate_(dateValue);
  logAudit_("attendance_scan", actorUser.user_id, {
    student_id: student.student_id,
    date: dateValue,
    status: status,
    late: isLate
  });
  return {
    attendance: row,
    student: pickPublicStudent_(student),
    waResult: waResult,
    dailyRecap: recap
  };
}

function findAttendanceByDateAndStudent_(dateValue, studentId) {
  var rows = readObjects_(APP_CONFIG.SHEETS.ATTENDANCE);
  var match = rows.find(function (r) {
    return r.date === dateValue && r.student_id === studentId;
  });
  return match || null;
}

function refreshDailyRecapForDate_(dateValue) {
  var rows = readObjects_(APP_CONFIG.SHEETS.ATTENDANCE);
  var totalStudents = listStudentsInternal_({ activeOnly: true }).length;
  var recap = buildDailyRecap_(rows, dateValue, totalStudents);
  upsertById_(APP_CONFIG.SHEETS.ATTENDANCE_RECAP_DAILY, "date", recap);
  return recap;
}

function buildDailyRecap_(attendanceRows, dateValue, totalStudents) {
  var filtered = attendanceRows.filter(function (r) { return r.date === dateValue; });
  var counters = {
    hadir: 0,
    sakit: 0,
    izin: 0,
    alfa: 0,
    late_count: 0
  };
  filtered.forEach(function (r) {
    if (counters.hasOwnProperty(r.status)) counters[r.status] += 1;
    if (toBool_(r.is_late)) counters.late_count += 1;
  });
  var presentRate = totalStudents ? (counters.hadir / totalStudents) * 100 : 0;
  return {
    date: dateValue,
    total_students: totalStudents,
    hadir: counters.hadir,
    sakit: counters.sakit,
    izin: counters.izin,
    alfa: counters.alfa,
    late_count: counters.late_count,
    present_rate: Math.round(presentRate * 100) / 100,
    updated_at: isoNow_()
  };
}

function buildMonthlyRecap_(attendanceRows, month, year, totalStudents) {
  var map = {};
  attendanceRows.forEach(function (r) {
    var parts = String(r.date || "").split("-");
    if (parts.length !== 3) return;
    if (Number(parts[0]) !== Number(year) || Number(parts[1]) !== Number(month)) return;
    if (!map[r.date]) {
      map[r.date] = buildDailyRecap_(attendanceRows, r.date, totalStudents);
    }
  });
  var rows = Object.keys(map).sort().map(function (k) { return map[k]; });
  var totals = rows.reduce(
    function (acc, row) {
      acc.hadir += Number(row.hadir || 0);
      acc.sakit += Number(row.sakit || 0);
      acc.izin += Number(row.izin || 0);
      acc.alfa += Number(row.alfa || 0);
      acc.late_count += Number(row.late_count || 0);
      return acc;
    },
    { hadir: 0, sakit: 0, izin: 0, alfa: 0, late_count: 0 }
  );
  return {
    month: month,
    year: year,
    days: rows,
    totals: totals
  };
}

function normalizeGradeRow_(data, teacherId) {
  var now = isoNow_();
  var row = {
    grade_id: normalizeText_(data.grade_id) || "GRD-" + shortId_(),
    student_id: normalizeText_(data.student_id),
    subject: normalizeText_(data.subject),
    objective_code: normalizeText_(data.objective_code),
    objective_text: normalizeText_(data.objective_text),
    nilai_harian: clampScore_(data.nilai_harian),
    nilai_tugas: clampScore_(data.nilai_tugas),
    nilai_pts: clampScore_(data.nilai_pts),
    nilai_pas: clampScore_(data.nilai_pas),
    nilai_sikap: clampScore_(data.nilai_sikap),
    nilai_produk: clampScore_(data.nilai_produk),
    semester: normalizeText_(data.semester || "Genap"),
    academic_year: normalizeText_(data.academic_year || defaultAcademicYear_()),
    teacher_id: teacherId,
    created_at: normalizeText_(data.created_at) || now,
    updated_at: now
  };
  if (!row.student_id) throw new Error("student_id wajib.");
  if (!row.subject) throw new Error("Mata pelajaran wajib diisi.");
  if (APP_CONFIG.SUBJECTS.indexOf(row.subject) < 0) {
    throw new Error("Mata pelajaran tidak terdaftar.");
  }
  if (!row.objective_code) row.objective_code = "TP-" + shortId_();
  var finalResult = calculateFinalScore_(row);
  row.final_score = finalResult.finalScore;
  row.predicate = finalResult.predicate;
  return row;
}

function upsertGrade_(row) {
  var rows = readObjects_(APP_CONFIG.SHEETS.GRADES);
  var existing = rows.find(function (r) {
    return (
      r.student_id === row.student_id &&
      r.subject === row.subject &&
      r.objective_code === row.objective_code &&
      r.semester === row.semester &&
      r.academic_year === row.academic_year
    );
  });
  if (existing) {
    row.grade_id = existing.grade_id;
    row.created_at = existing.created_at || row.created_at;
  }
  upsertById_(APP_CONFIG.SHEETS.GRADES, "grade_id", row);
}

function calculateFinalScore_(gradeRow) {
  var settings = getSettingsMap_();
  var weight = {
    harian: toNumber_(settings.WEIGHT_HARIAN, 20),
    tugas: toNumber_(settings.WEIGHT_TUGAS, 20),
    pts: toNumber_(settings.WEIGHT_PTS, 20),
    pas: toNumber_(settings.WEIGHT_PAS, 25),
    sikap: toNumber_(settings.WEIGHT_SIKAP, 10),
    produk: toNumber_(settings.WEIGHT_PRODUK, 5)
  };
  var totalWeight =
    weight.harian +
    weight.tugas +
    weight.pts +
    weight.pas +
    weight.sikap +
    weight.produk;
  if (!totalWeight) totalWeight = 100;
  var score =
    (toNumber_(gradeRow.nilai_harian) * weight.harian +
      toNumber_(gradeRow.nilai_tugas) * weight.tugas +
      toNumber_(gradeRow.nilai_pts) * weight.pts +
      toNumber_(gradeRow.nilai_pas) * weight.pas +
      toNumber_(gradeRow.nilai_sikap) * weight.sikap +
      toNumber_(gradeRow.nilai_produk) * weight.produk) /
    totalWeight;
  score = Math.round(score * 100) / 100;
  return {
    finalScore: score,
    predicate: scoreToPredicate_(score)
  };
}

function scoreToPredicate_(score) {
  if (score >= 90) return "A";
  if (score >= 80) return "B";
  if (score >= 70) return "C";
  return "D";
}

function getDashboardAnalyticsInternal_(user) {
  var students = listStudentsInternal_({ activeOnly: true });
  var attendances = readObjects_(APP_CONFIG.SHEETS.ATTENDANCE);
  var grades = readObjects_(APP_CONFIG.SHEETS.GRADES);
  var counseling = readObjects_(APP_CONFIG.SHEETS.COUNSELING);

  var today = dateKey_(new Date());
  var todayRecap = buildDailyRecap_(attendances, today, students.length);

  var month = Number(formatDate_(new Date(), "MM"));
  var year = Number(formatDate_(new Date(), "yyyy"));
  var monthly = buildMonthlyRecap_(attendances, month, year, students.length);

  var gradeBySubject = {};
  APP_CONFIG.SUBJECTS.forEach(function (subject) {
    var sRows = grades.filter(function (g) { return g.subject === subject; });
    var avg = 0;
    if (sRows.length) {
      avg =
        sRows.reduce(function (sum, g) { return sum + toNumber_(g.final_score); }, 0) /
        sRows.length;
    }
    gradeBySubject[subject] = Math.round(avg * 100) / 100;
  });

  var violationCount = {};
  counseling.forEach(function (item) {
    var key = normalizeText_(item.violation_type) || "Lainnya";
    violationCount[key] = (violationCount[key] || 0) + 1;
  });
  var topViolations = Object.keys(violationCount)
    .map(function (k) { return { violation_type: k, count: violationCount[k] }; })
    .sort(function (a, b) { return b.count - a.count; })
    .slice(0, 5);

  return {
    user: pickPublicUser_(user),
    studentsTotal: students.length,
    attendanceToday: todayRecap,
    attendanceMonthly: monthly,
    gradeAverageBySubject: gradeBySubject,
    topViolations: topViolations,
    offlineSuggested: true
  };
}

function sendAttendanceWhatsApp_(student, attendanceRow) {
  var msg =
    "Yth. Orang Tua/Wali " +
    student.full_name +
    ",\n" +
    "Presensi hari ini tercatat:\n" +
    "- Tanggal: " +
    attendanceRow.date +
    "\n" +
    "- Status: " +
    attendanceRow.status.toUpperCase() +
    "\n" +
    "- Jam: " +
    attendanceRow.check_in_time +
    "\n" +
    "- Terlambat: " +
    (attendanceRow.is_late ? "Ya" : "Tidak") +
    "\n\n" +
    "Terima kasih.";
  return sendWhatsAppMessage_(student.parent_wa, msg);
}

function sendCounselingWhatsApp_(student, counselingRow) {
  var msg =
    "Pemberitahuan Buku Konseling\n" +
    "Siswa: " +
    student.full_name +
    "\n" +
    "Tanggal: " +
    counselingRow.tanggal +
    "\n" +
    "Pelanggaran: " +
    counselingRow.violation_type +
    "\n" +
    "Penanganan: " +
    counselingRow.handling +
    "\n" +
    "Tindak Lanjut: " +
    counselingRow.follow_up +
    "\n" +
    "Hasil: " +
    counselingRow.result;
  return sendWhatsAppMessage_(student.parent_wa, msg);
}

function sendWhatsAppMessage_(phoneNumber, messageText) {
  var phone = normalizePhone_(phoneNumber);
  if (!phone) return { sent: false, reason: "nomor orang tua belum diisi" };

  var props = PropertiesService.getScriptProperties();
  var apiUrl = normalizeText_(props.getProperty("WHATSAPP_API_URL"));
  var apiToken = normalizeText_(props.getProperty("WHATSAPP_API_TOKEN"));
  var sender = normalizeText_(props.getProperty("WHATSAPP_SENDER"));
  if (!apiUrl || !apiToken) {
    return {
      sent: false,
      reason: "Konfigurasi WhatsApp API belum lengkap di Script Properties."
    };
  }

  var payload = { to: phone, message: messageText };
  if (sender) payload.sender = sender;

  try {
    var res = UrlFetchApp.fetch(apiUrl, {
      method: "post",
      contentType: "application/json",
      headers: { Authorization: "Bearer " + apiToken },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });
    var statusCode = res.getResponseCode();
    return {
      sent: statusCode >= 200 && statusCode < 300,
      statusCode: statusCode,
      response: res.getContentText()
    };
  } catch (err) {
    return { sent: false, reason: String(err.message || err) };
  }
}

function ensureAllSheets_(ss) {
  Object.keys(SHEET_HEADERS).forEach(function (sheetName) {
    var sheet = ss.getSheetByName(sheetName);
    if (!sheet) sheet = ss.insertSheet(sheetName);
    ensureHeaders_(sheetName, sheet);
  });
}

function seedSettings_() {
  var defaults = [
    { key: "LATE_TIME", value: APP_CONFIG.ATTENDANCE_CUTOFF_DEFAULT },
    { key: "WEIGHT_HARIAN", value: "20" },
    { key: "WEIGHT_TUGAS", value: "20" },
    { key: "WEIGHT_PTS", value: "20" },
    { key: "WEIGHT_PAS", value: "25" },
    { key: "WEIGHT_SIKAP", value: "10" },
    { key: "WEIGHT_PRODUK", value: "5" }
  ];
  var existing = readObjects_(APP_CONFIG.SHEETS.SETTINGS);
  var map = buildMapBy_(existing, "key");
  defaults.forEach(function (d) {
    if (!map[d.key]) {
      appendObject_(APP_CONFIG.SHEETS.SETTINGS, {
        key: d.key,
        value: d.value,
        updated_at: isoNow_()
      });
    }
  });
  clearSettingsCache_();
}

function seedDefaultUsers_() {
  var users = listUsersInternal_({ activeOnly: false });
  if (users.length > 0) return;
  var now = isoNow_();
  var defaults = [
    {
      user_id: "USR-ADMIN",
      username: "admin",
      full_name: "Administrator Sekolah",
      email: "admin@sd.local",
      role: "admin",
      password_hash: hashPassword_("admin123"),
      wa_number: "",
      is_active: true,
      last_login_at: "",
      created_at: now,
      updated_at: now
    },
    {
      user_id: "USR-T001",
      username: "guru1",
      full_name: "Guru Kelas 4A",
      email: "guru1@sd.local",
      role: "teacher",
      password_hash: hashPassword_("guru123"),
      wa_number: "",
      is_active: true,
      last_login_at: "",
      created_at: now,
      updated_at: now
    }
  ];
  defaults.forEach(function (u) {
    appendObject_(APP_CONFIG.SHEETS.USERS, u);
  });
  clearUsersCache_();
}

function getDb_() {
  var props = PropertiesService.getScriptProperties();
  var id = normalizeText_(props.getProperty("SPREADSHEET_ID"));
  if (id) return SpreadsheetApp.openById(id);
  if (SpreadsheetApp.getActiveSpreadsheet()) return SpreadsheetApp.getActiveSpreadsheet();
  throw new Error("SPREADSHEET_ID belum diset di Script Properties.");
}

function getSheet_(sheetName) {
  var ss = getDb_();
  var sh = ss.getSheetByName(sheetName);
  if (!sh) {
    sh = ss.insertSheet(sheetName);
    ensureHeaders_(sheetName, sh);
  }
  return sh;
}

function ensureHeaders_(sheetName, sheet) {
  var headers = SHEET_HEADERS[sheetName];
  if (!headers) throw new Error("Header sheet tidak didefinisikan: " + sheetName);
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    return;
  }
  var current = sheet.getRange(1, 1, 1, Math.max(headers.length, 1)).getValues()[0];
  var mismatch = headers.some(function (h, idx) { return String(current[idx] || "") !== h; });
  if (mismatch) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  }
}

function readObjects_(sheetName) {
  var sh = getSheet_(sheetName);
  ensureHeaders_(sheetName, sh);
  var lastRow = sh.getLastRow();
  var headers = SHEET_HEADERS[sheetName];
  if (lastRow < 2) return [];
  var values = sh.getRange(2, 1, lastRow - 1, headers.length).getValues();
  return values
    .filter(function (row) {
      return row.some(function (v) { return String(v || "") !== ""; });
    })
    .map(function (row) {
      var obj = {};
      headers.forEach(function (h, i) { obj[h] = row[i]; });
      return obj;
    });
}

function appendObject_(sheetName, obj) {
  var sh = getSheet_(sheetName);
  ensureHeaders_(sheetName, sh);
  var headers = SHEET_HEADERS[sheetName];
  var row = headers.map(function (h) {
    var value = obj[h];
    if (typeof value === "boolean") return value ? true : false;
    return value === undefined || value === null ? "" : value;
  });
  sh.appendRow(row);
}

function upsertById_(sheetName, idField, obj) {
  var sh = getSheet_(sheetName);
  ensureHeaders_(sheetName, sh);
  var headers = SHEET_HEADERS[sheetName];
  var idIndex = headers.indexOf(idField);
  if (idIndex < 0) throw new Error("id field tidak ditemukan: " + idField);
  var idValue = obj[idField];
  if (!idValue) throw new Error("Nilai id kosong untuk upsert: " + idField);
  var lastRow = sh.getLastRow();
  if (lastRow < 2) {
    appendObject_(sheetName, obj);
    return;
  }
  var data = sh.getRange(2, 1, lastRow - 1, headers.length).getValues();
  var foundRow = -1;
  for (var i = 0; i < data.length; i++) {
    if (String(data[i][idIndex]) === String(idValue)) {
      foundRow = i + 2;
      break;
    }
  }
  var rowValues = headers.map(function (h) {
    var v = obj[h];
    if (typeof v === "boolean") return v ? true : false;
    return v === undefined || v === null ? "" : v;
  });
  if (foundRow === -1) {
    sh.appendRow(rowValues);
  } else {
    sh.getRange(foundRow, 1, 1, headers.length).setValues([rowValues]);
  }
}

function listStudentsInternal_(opts) {
  opts = opts || {};
  var useCache = opts.activeOnly !== false;
  if (useCache) {
    var cached = getCacheJson_(APP_CONFIG.CACHE_KEYS.STUDENTS);
    if (cached) return cached;
  }
  var rows = readObjects_(APP_CONFIG.SHEETS.STUDENTS);
  if (opts.activeOnly !== false) {
    rows = rows.filter(function (r) { return toBool_(r.is_active); });
  }
  rows.sort(function (a, b) {
    return String(a.full_name || "").localeCompare(String(b.full_name || ""), "id");
  });
  if (useCache) putCacheJson_(APP_CONFIG.CACHE_KEYS.STUDENTS, rows, 300);
  return rows;
}

function clearStudentsCache_() {
  CacheService.getScriptCache().remove(APP_CONFIG.CACHE_KEYS.STUDENTS);
}

function listUsersInternal_(opts) {
  opts = opts || {};
  var useCache = opts.activeOnly !== false;
  if (useCache) {
    var cached = getCacheJson_(APP_CONFIG.CACHE_KEYS.USERS);
    if (cached) return cached;
  }
  var rows = readObjects_(APP_CONFIG.SHEETS.USERS);
  if (opts.activeOnly !== false) {
    rows = rows.filter(function (r) { return toBool_(r.is_active); });
  }
  if (useCache) putCacheJson_(APP_CONFIG.CACHE_KEYS.USERS, rows, 300);
  return rows;
}

function clearUsersCache_() {
  CacheService.getScriptCache().remove(APP_CONFIG.CACHE_KEYS.USERS);
}

function findStudentById_(studentId) {
  var rows = listStudentsInternal_({ activeOnly: false });
  return (
    rows.find(function (r) {
      return String(r.student_id) === String(studentId);
    }) || null
  );
}

function resolveStudentFromScanPayload_(payload) {
  if (payload.student_id) {
    var student = findStudentById_(payload.student_id);
    if (!student) throw new Error("Siswa tidak ditemukan.");
    return student;
  }
  var qrRaw = normalizeText_(payload.qr_data);
  if (!qrRaw) throw new Error("qr_data atau student_id wajib.");
  var parsed = parseStudentQrPayload_(qrRaw);
  if (!parsed.student_id || !parsed.token) throw new Error("Format QR tidak valid.");
  var target = findStudentById_(parsed.student_id);
  if (!target) throw new Error("Siswa QR tidak ditemukan.");
  if (String(target.qr_token || "") !== parsed.token) {
    throw new Error("Token QR siswa tidak cocok.");
  }
  return target;
}

function parseStudentQrPayload_(raw) {
  var parts = String(raw || "").split("|");
  if (parts.length !== 3 || parts[0] !== "STU") {
    return { student_id: "", token: "" };
  }
  return { student_id: parts[1], token: parts[2] };
}

function buildStudentQrPayload_(student) {
  return "STU|" + student.student_id + "|" + student.qr_token;
}

function getSettingsMap_() {
  var cached = getCacheJson_(APP_CONFIG.CACHE_KEYS.SETTINGS);
  if (cached) return cached;
  var rows = readObjects_(APP_CONFIG.SHEETS.SETTINGS);
  var out = {};
  rows.forEach(function (row) {
    out[row.key] = row.value;
  });
  putCacheJson_(APP_CONFIG.CACHE_KEYS.SETTINGS, out, 300);
  return out;
}

function clearSettingsCache_() {
  CacheService.getScriptCache().remove(APP_CONFIG.CACHE_KEYS.SETTINGS);
}

function createSession_(user) {
  var token = Utilities.getUuid().replace(/-/g, "");
  var session = {
    token: token,
    user: pickPublicUser_(user),
    createdAt: isoNow_()
  };
  CacheService.getScriptCache().put(
    "session:" + token,
    JSON.stringify(session),
    APP_CONFIG.SESSION_TTL_SECONDS
  );
  return token;
}

function requireSession_(token) {
  var val = CacheService.getScriptCache().get("session:" + String(token || ""));
  if (!val) throw new Error("Sesi tidak valid atau sudah kedaluwarsa.");
  var session = JSON.parse(val);
  if (!session || !session.user || !session.user.user_id) {
    throw new Error("Data sesi tidak valid.");
  }
  return session;
}

function requireRole_(token, roles) {
  var session = requireSession_(token);
  if (roles.indexOf(session.user.role) < 0) {
    throw new Error("Akses ditolak untuk role " + session.user.role);
  }
  return session;
}

function clearSession_(token) {
  if (!token) return;
  CacheService.getScriptCache().remove("session:" + token);
}

function updateUserLoginTime_(userId) {
  var users = listUsersInternal_({ activeOnly: false });
  var user = users.find(function (u) { return u.user_id === userId; });
  if (!user) return;
  user.last_login_at = isoNow_();
  user.updated_at = isoNow_();
  upsertById_(APP_CONFIG.SHEETS.USERS, "user_id", user);
  clearUsersCache_();
}

function pickPublicUser_(user) {
  return {
    user_id: user.user_id,
    username: user.username,
    full_name: user.full_name,
    email: user.email,
    role: user.role,
    wa_number: user.wa_number,
    is_active: toBool_(user.is_active),
    last_login_at: user.last_login_at
  };
}

function pickPublicStudent_(student) {
  return {
    student_id: student.student_id,
    nisn: student.nisn,
    full_name: student.full_name,
    class_name: student.class_name,
    gender: student.gender,
    parent_name: student.parent_name,
    parent_wa: student.parent_wa,
    is_active: toBool_(student.is_active),
    qr_token: student.qr_token
  };
}

function hashPassword_(rawPassword) {
  var digest = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    String(rawPassword || ""),
    Utilities.Charset.UTF_8
  );
  return Utilities.base64Encode(digest);
}

function getCacheJson_(key) {
  var raw = CacheService.getScriptCache().get(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (err) {
    return null;
  }
}

function putCacheJson_(key, obj, seconds) {
  CacheService.getScriptCache().put(key, JSON.stringify(obj), seconds || 120);
}

function logAudit_(eventType, userId, payloadObj) {
  try {
    appendObject_(APP_CONFIG.SHEETS.AUDIT_LOG, {
      log_id: "LOG-" + shortId_(),
      event_type: normalizeText_(eventType),
      user_id: normalizeText_(userId),
      payload_json: JSON.stringify(payloadObj || {}),
      created_at: isoNow_()
    });
  } catch (err) {
    // Audit tidak mengganggu proses utama.
  }
}

function buildMapBy_(rows, keyField) {
  var map = {};
  rows.forEach(function (r) {
    map[r[keyField]] = r;
  });
  return map;
}

function normalizeStatus_(status) {
  var s = String(status || "").toLowerCase();
  if (APP_CONFIG.ATTENDANCE_STATUSES.indexOf(s) < 0) {
    throw new Error("Status kehadiran tidak valid: " + status);
  }
  return s;
}

function normalizePhone_(phone) {
  var raw = String(phone || "").replace(/[^\d+]/g, "");
  if (!raw) return "";
  if (raw.indexOf("+") === 0) raw = raw.substring(1);
  if (raw.indexOf("0") === 0) raw = "62" + raw.substring(1);
  if (raw.indexOf("62") !== 0) raw = "62" + raw;
  return raw;
}

function normalizeText_(value) {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

function toBool_(v) {
  if (typeof v === "boolean") return v;
  var s = String(v || "").toLowerCase();
  return s === "true" || s === "1" || s === "yes";
}

function toNumber_(v, fallback) {
  var n = Number(v);
  return isNaN(n) ? Number(fallback || 0) : n;
}

function clampScore_(value) {
  var n = toNumber_(value, 0);
  if (n < 0) n = 0;
  if (n > 100) n = 100;
  return Math.round(n * 100) / 100;
}

function isAfterTime_(timeValue, cutoff) {
  var t = parseTimeToMinutes_(timeValue);
  var c = parseTimeToMinutes_(cutoff);
  return t > c;
}

function parseTimeToMinutes_(timeValue) {
  var s = String(timeValue || "00:00").split(":");
  var hh = Number(s[0] || 0);
  var mm = Number(s[1] || 0);
  return hh * 60 + mm;
}

function isoNow_() {
  return formatDate_(new Date(), "yyyy-MM-dd'T'HH:mm:ss");
}

function dateKey_(dateObj) {
  return formatDate_(dateObj, "yyyy-MM-dd");
}

function formatDate_(dateObj, format) {
  return Utilities.formatDate(dateObj, APP_CONFIG.TIMEZONE, format);
}

function shortId_() {
  return Utilities.getUuid().split("-")[0].toUpperCase();
}

function defaultAcademicYear_() {
  var year = Number(formatDate_(new Date(), "yyyy"));
  var month = Number(formatDate_(new Date(), "MM"));
  if (month >= 7) return year + "/" + (year + 1);
  return year - 1 + "/" + year;
}
