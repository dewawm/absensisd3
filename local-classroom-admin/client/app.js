const state = {
  token: localStorage.getItem("class_admin_token") || "",
  user: null,
  settings: {},
  students: [],
  attendance: [],
  grades: [],
  journals: [],
  counseling: [],
  analytics: null,
  offlineQueue: JSON.parse(localStorage.getItem("class_admin_offline_queue") || "[]"),
  scanner: null
};

const views = {
  dashboard: { title: "Dashboard", sub: "Ringkasan data kelas." },
  students: { title: "Data Siswa", sub: "Master siswa dan QR generator." },
  attendance: { title: "QR Attendance", sub: "Scan QR, edit manual, rekap." },
  grades: { title: "Manajemen Nilai", sub: "Penilaian per TP dan auto final score." },
  journals: { title: "Jurnal Mengajar", sub: "Dokumentasi kegiatan pembelajaran." },
  counseling: { title: "Buku Konseling", sub: "Log pelanggaran, tindak lanjut, hasil." }
};

document.addEventListener("DOMContentLoaded", () => {
  bindEvents();
  setDefaultDates();
  populateMonthYear();
  updateQueueBadge();
  if (state.token) bootstrap().catch(() => logoutUiOnly());
});

function bindEvents() {
  document.getElementById("loginForm").addEventListener("submit", onLogin);
  document.getElementById("logoutBtn").addEventListener("click", logout);
  document.getElementById("openMenuBtn").addEventListener("click", () => {
    document.getElementById("sidebar").classList.toggle("open");
  });
  document.getElementById("syncQueueBtn").addEventListener("click", syncOfflineQueue);
  window.addEventListener("online", syncOfflineQueue);

  qsa(".nav-btn[data-view]").forEach((btn) =>
    btn.addEventListener("click", () => showView(btn.dataset.view))
  );

  bindStudents();
  bindAttendance();
  bindGrades();
  bindJournals();
  bindCounseling();
}

async function onLogin(e) {
  e.preventDefault();
  try {
    const payload = await api("/api/auth/login", "POST", {
      username: val("loginUsername"),
      password: val("loginPassword")
    });
    state.token = payload.data.token;
    localStorage.setItem("class_admin_token", state.token);
    await bootstrap();
    toast("Login berhasil");
  } catch (error) {
    toast(error.message);
  }
}

async function bootstrap() {
  const result = await api("/api/bootstrap");
  state.user = result.data.user;
  state.settings = result.data.settings || {};
  state.students = result.data.students || [];
  document.getElementById("lateCutoffBadge").textContent = state.settings.LATE_TIME || "07:30";
  document.getElementById("userLabel").textContent = `${state.user.fullName} (${state.user.role})`;
  document.getElementById("mobileUserLabel").textContent = `${state.user.fullName} (${state.user.role})`;

  const isAdmin = state.user.role === "admin";
  qsa(".admin-only").forEach((el) => el.classList.toggle("hidden", !isAdmin));
  renderStudentSelects();
  renderStudentsTable();

  document.getElementById("loginScreen").classList.add("hidden");
  document.getElementById("appShell").classList.remove("hidden");
  showView("dashboard");

  await Promise.all([
    loadDashboard(),
    loadAttendance(),
    loadAttendanceRecap(),
    loadGrades(),
    loadJournals(),
    loadCounseling()
  ]);
}

async function logout() {
  logoutUiOnly();
}

function logoutUiOnly() {
  state.token = "";
  state.user = null;
  localStorage.removeItem("class_admin_token");
  document.getElementById("appShell").classList.add("hidden");
  document.getElementById("loginScreen").classList.remove("hidden");
}

function showView(name) {
  qsa(".view").forEach((v) => v.classList.add("hidden"));
  qsa(".nav-btn[data-view]").forEach((btn) =>
    btn.classList.toggle("active", btn.dataset.view === name)
  );
  qs(`#view-${name}`).classList.remove("hidden");
  document.getElementById("sidebar").classList.remove("open");
  document.getElementById("pageTitle").textContent = views[name].title;
  document.getElementById("pageSub").textContent = views[name].sub;
}

function bindStudents() {
  document.getElementById("studentForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      await api("/api/students", "POST", {
        id: val("studentId"),
        full_name: val("studentName"),
        nisn: val("studentNisn"),
        class_name: val("studentClass"),
        gender: val("studentGender"),
        parent_name: val("parentName"),
        parent_wa: val("parentWa")
      });
      toast("Siswa tersimpan");
      resetStudentForm();
      await refreshStudents();
    } catch (error) {
      toast(error.message);
    }
  });

  document.getElementById("studentResetBtn").addEventListener("click", resetStudentForm);
  document.getElementById("studentSearch").addEventListener("input", renderStudentsTable);

  document.getElementById("genQrBtn").addEventListener("click", async () => {
    const id = val("qrStudentSelect");
    if (!id) return toast("Pilih siswa.");
    try {
      const result = await api(`/api/students/${encodeURIComponent(id)}/qr`);
      const qr = result.data;
      document.getElementById("qrBox").classList.remove("hidden");
      document.getElementById("qrImage").src = qr.imageDataUrl;
      document.getElementById("qrText").textContent = qr.qrPayload;
    } catch (error) {
      toast(error.message);
    }
  });

  document.getElementById("batchQrBtn").addEventListener("click", async () => {
    try {
      const result = await api("/api/students/qr/batch");
      const first = (result.data || [])[0];
      if (!first) return toast("Belum ada siswa.");
      document.getElementById("qrBox").classList.remove("hidden");
      document.getElementById("qrImage").src = first.imageDataUrl;
      document.getElementById("qrText").textContent = `Contoh: ${first.qrPayload} (total ${result.data.length})`;
    } catch (error) {
      toast(error.message);
    }
  });
}

async function refreshStudents() {
  const result = await api("/api/students");
  state.students = result.data || [];
  renderStudentSelects();
  renderStudentsTable();
}

function renderStudentSelects() {
  const options =
    "<option value=''>- Pilih Siswa -</option>" +
    state.students
      .map((s) => `<option value="${esc(s.id)}">${esc(s.full_name)}</option>`)
      .join("");
  ["qrStudentSelect", "manualStudent", "gradeStudent", "counselingStudent"].forEach((id) => {
    const el = qs(`#${id}`);
    if (el) el.innerHTML = options;
  });
  const filter = qs("#counselingFilterStudent");
  if (filter) {
    filter.innerHTML =
      "<option value=''>Semua</option>" +
      state.students.map((s) => `<option value="${esc(s.id)}">${esc(s.full_name)}</option>`).join("");
  }
}

function renderStudentsTable() {
  const q = val("studentSearch").toLowerCase();
  const rows = state.students.filter(
    (s) =>
      (s.full_name || "").toLowerCase().includes(q) ||
      String(s.nisn || "").toLowerCase().includes(q)
  );
  qs("#studentsBody").innerHTML = rows
    .map(
      (s) => `<tr>
        <td>${esc(s.id)}</td>
        <td>${esc(s.full_name)}</td>
        <td>${esc(s.nisn || "-")}</td>
        <td>${esc(s.class_name || "-")}</td>
        <td>${esc(s.parent_name || "-")}</td>
        <td>${esc(s.parent_wa || "-")}</td>
        <td><button class="btn" onclick="editStudent('${escJs(s.id)}')">Edit</button></td>
      </tr>`
    )
    .join("");
}

window.editStudent = function (id) {
  const s = state.students.find((x) => x.id === id);
  if (!s) return;
  setVal("studentId", s.id || "");
  setVal("studentName", s.full_name || "");
  setVal("studentNisn", s.nisn || "");
  setVal("studentClass", s.class_name || "");
  setVal("studentGender", s.gender || "");
  setVal("parentName", s.parent_name || "");
  setVal("parentWa", s.parent_wa || "");
  showView("students");
};

function resetStudentForm() {
  ["studentId", "studentName", "studentNisn", "studentClass", "studentGender", "parentName", "parentWa"].forEach(
    (id) => setVal(id, "")
  );
  setVal("studentClass", "Kelas 4");
}

function bindAttendance() {
  qs("#submitScanBtn").addEventListener("click", async () => {
    const payload = {
      qr_data: val("qrDataInput"),
      date: val("attendanceDate"),
      source: "qr_scan"
    };
    await submitAttendance(payload, "attendance_scan");
  });

  qs("#manualAttendanceForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const payload = {
      student_id: val("manualStudent"),
      status: val("manualStatus"),
      check_in_time: val("manualTime"),
      date: val("attendanceDate"),
      note: val("manualNote")
    };
    try {
      await api("/api/attendance/manual", "POST", payload);
      toast("Attendance manual tersimpan");
      await Promise.all([loadAttendance(), loadAttendanceRecap(), loadDashboard()]);
    } catch (error) {
      queueOffline("attendance_manual", payload, error);
    }
  });

  qs("#attendanceSearch").addEventListener("input", renderAttendanceTable);
  qs("#refreshRecapBtn").addEventListener("click", loadAttendanceRecap);
  qs("#attendanceDate").addEventListener("change", () => {
    loadAttendance();
    loadAttendanceRecap();
  });
  qs("#toggleCameraBtn").addEventListener("click", toggleScanner);
}

async function submitAttendance(payload, queueType) {
  if (!payload.qr_data && !payload.student_id) return toast("QR/student kosong.");
  try {
    const result = await api("/api/attendance/scan", "POST", payload);
    const waSent = !!(result.data.waResult || {}).sent;
    toast(`Scan berhasil. WA ${waSent ? "terkirim" : "gagal/skip"}`);
    setVal("qrDataInput", "");
    await Promise.all([loadAttendance(), loadAttendanceRecap(), loadDashboard()]);
  } catch (error) {
    queueOffline(queueType, payload, error);
  }
}

async function loadAttendance() {
  const result = await api(`/api/attendance?date=${encodeURIComponent(val("attendanceDate"))}`);
  state.attendance = result.data || [];
  renderAttendanceTable();
}

async function loadAttendanceRecap() {
  const result = await api(
    `/api/attendance/recap?date=${encodeURIComponent(val("attendanceDate"))}&month=${encodeURIComponent(val("recapMonth"))}&year=${encodeURIComponent(val("recapYear"))}`
  );
  const totals = ((result.data || {}).monthly || {}).totals || {};
  setText("rHadir", totals.hadir || 0);
  setText("rSakitIzin", Number(totals.sakit || 0) + Number(totals.izin || 0));
  setText("rAlfa", totals.alfa || 0);
}

function renderAttendanceTable() {
  const q = val("attendanceSearch").toLowerCase();
  const rows = state.attendance.filter((r) => (r.student_name || "").toLowerCase().includes(q));
  qs("#attendanceBody").innerHTML = rows
    .map(
      (r) => `<tr>
        <td>${esc(r.date)}</td>
        <td>${esc(r.student_name)}</td>
        <td><span class="badge ${esc(r.status)}">${esc(r.status)}</span></td>
        <td>${esc(r.check_in_time || "-")}</td>
        <td>${r.is_late ? "Ya" : "Tidak"}</td>
        <td>${esc(r.note || "-")}</td>
        <td>${esc(r.teacher_name || "-")}</td>
      </tr>`
    )
    .join("");
}

async function toggleScanner() {
  if (!window.Html5Qrcode) return toast("Scanner library tidak tersedia.");
  if (state.scanner) {
    await state.scanner.stop();
    await state.scanner.clear();
    state.scanner = null;
    toast("Scanner berhenti");
    return;
  }
  state.scanner = new Html5Qrcode("qrReader");
  try {
    await state.scanner.start(
      { facingMode: "environment" },
      { fps: 10, qrbox: 220 },
      async (decodedText) => {
        await submitAttendance({ qr_data: decodedText, date: val("attendanceDate"), source: "qr_camera" }, "attendance_scan");
        if (state.scanner) {
          await state.scanner.stop();
          await state.scanner.clear();
          state.scanner = null;
        }
      }
    );
    toast("Scanner aktif");
  } catch (error) {
    state.scanner = null;
    toast(`Gagal buka kamera: ${error}`);
  }
}

function bindGrades() {
  qsa(".grade-num").forEach((i) => i.addEventListener("input", updateGradePreview));
  qs("#gradeForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const payload = {
      student_id: val("gradeStudent"),
      subject: val("gradeSubject"),
      objective_code: val("gradeTpCode"),
      objective_text: val("gradeTpText"),
      nilai_harian: num("nh"),
      nilai_tugas: num("nt"),
      nilai_pts: num("npts"),
      nilai_pas: num("npas"),
      nilai_sikap: num("nsikap"),
      nilai_produk: num("nproduk"),
      semester: val("gradeFilterSemester") || "Genap",
      academic_year: val("gradeAcademicYear") || defaultAcademicYear()
    };
    try {
      await api("/api/grades", "POST", payload);
      toast("Nilai tersimpan");
      await Promise.all([loadGrades(), loadDashboard()]);
    } catch (error) {
      queueOffline("grade_save", payload, error);
    }
  });

  qs("#loadGradesBtn").addEventListener("click", loadGrades);
  qs("#exportGradesBtn").addEventListener("click", async () => {
    try {
      await downloadWithAuth("/api/grades/export.csv", "grades-export.csv");
      toast("Export CSV berhasil");
    } catch (error) {
      toast(error.message);
    }
  });
}

function updateGradePreview() {
  const v = [num("nh"), num("nt"), num("npts"), num("npas"), num("nsikap"), num("nproduk")];
  const w = [20, 20, 20, 25, 10, 5];
  let sum = 0;
  for (let i = 0; i < v.length; i++) sum += v[i] * w[i];
  setText("gradePreview", (sum / 100).toFixed(2));
}

async function loadGrades() {
  const qsParams = new URLSearchParams({
    subject: val("gradeFilterSubject"),
    semester: val("gradeFilterSemester"),
    academic_year: val("gradeAcademicYear")
  });
  const result = await api(`/api/grades?${qsParams.toString()}`);
  state.grades = result.data || [];
  qs("#gradesBody").innerHTML = state.grades
    .map(
      (g) => `<tr>
      <td>${esc(g.student_name || "-")}</td>
      <td>${esc(g.subject)}</td>
      <td>${esc((g.objective_code || "-") + " " + (g.objective_text || ""))}</td>
      <td>${g.nilai_harian}</td><td>${g.nilai_tugas}</td><td>${g.nilai_pts}</td><td>${g.nilai_pas}</td><td>${g.nilai_sikap}</td><td>${g.nilai_produk}</td>
      <td><b>${g.final_score}</b></td><td>${esc(g.predicate)}</td>
    </tr>`
    )
    .join("");
}

function bindJournals() {
  qs("#journalForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const payload = {
      tanggal: val("journalDate"),
      mata_pelajaran: val("journalSubject"),
      tujuan_pembelajaran: val("journalTp"),
      materi: val("journalMateri"),
      kendala: val("journalKendala"),
      jam_waktu: val("journalJam")
    };
    try {
      await api("/api/journals", "POST", payload);
      toast("Jurnal tersimpan");
      await loadJournals();
    } catch (error) {
      queueOffline("journal_save", payload, error);
    }
  });
  qs("#loadJournalBtn").addEventListener("click", loadJournals);
}

async function loadJournals() {
  const params = new URLSearchParams({
    tanggal: val("journalFilterDate"),
    mata_pelajaran: val("journalFilterSubject")
  });
  const result = await api(`/api/journals?${params.toString()}`);
  state.journals = result.data || [];
  qs("#journalsBody").innerHTML = state.journals
    .map(
      (j) => `<tr>
      <td>${esc(j.tanggal)}</td><td>${esc(j.mata_pelajaran)}</td><td>${esc(j.tujuan_pembelajaran || "-")}</td>
      <td>${esc(j.materi || "-")}</td><td>${esc(j.kendala || "-")}</td><td>${esc(j.jam_waktu || "-")}</td><td>${esc(j.teacher_name || "-")}</td>
    </tr>`
    )
    .join("");
}

function bindCounseling() {
  qs("#counselingForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const payload = {
      tanggal: val("counselingDate"),
      student_id: val("counselingStudent"),
      violation_type: val("counselingViolation"),
      handling: val("counselingHandling"),
      follow_up: val("counselingFollow"),
      result: val("counselingResult"),
      notify_parent: qs("#counselingNotify").checked
    };
    try {
      const result = await api("/api/counselings", "POST", payload);
      const sent = (result.data.waResult || {}).sent;
      toast(`Konseling tersimpan. WA ${sent ? "terkirim" : "gagal/skip"}`);
      await Promise.all([loadCounseling(), loadDashboard()]);
    } catch (error) {
      queueOffline("counseling_save", payload, error);
    }
  });
  qs("#loadCounselingBtn").addEventListener("click", loadCounseling);
}

async function loadCounseling() {
  const params = new URLSearchParams({
    tanggal: val("counselingFilterDate"),
    student_id: val("counselingFilterStudent")
  });
  const result = await api(`/api/counselings?${params.toString()}`);
  state.counseling = result.data || [];
  qs("#counselingBody").innerHTML = state.counseling
    .map(
      (c) => `<tr>
      <td>${esc(c.tanggal)}</td><td>${esc(c.student_name)}</td><td>${esc(c.violation_type)}</td>
      <td>${esc(c.handling || "-")}</td><td>${esc(c.follow_up || "-")}</td><td>${esc(c.result || "-")}</td>
      <td>${c.parent_notified ? "Terkirim" : "Tidak"}</td><td>${esc(c.teacher_name || "-")}</td>
    </tr>`
    )
    .join("");
}

async function loadDashboard() {
  const result = await api("/api/dashboard/analytics");
  state.analytics = result.data || {};
  setText("kpiStudents", state.analytics.studentsTotal || 0);
  setText("kpiPresent", (state.analytics.attendanceToday || {}).hadir || 0);
  setText("kpiRate", `${(state.analytics.attendanceToday || {}).present_rate || 0}%`);

  const subjectHtml = Object.entries(state.analytics.gradeAverageBySubject || {})
    .map(([k, v]) => `<div class="row between"><span>${esc(k)}</span><b>${v}</b></div>`)
    .join("");
  qs("#subjectStats").innerHTML = subjectHtml || "-";

  const violHtml = (state.analytics.topViolations || [])
    .map((x) => `<div class="row between"><span>${esc(x.violation_type)}</span><b>${x.count}</b></div>`)
    .join("");
  qs("#violationStats").innerHTML = violHtml || "-";

  qs("#monthlyRecapBody").innerHTML = ((state.analytics.attendanceMonthly || {}).days || [])
    .map(
      (d) => `<tr><td>${esc(d.date)}</td><td>${d.hadir}</td><td>${d.sakit}</td><td>${d.izin}</td><td>${d.alfa}</td><td>${d.late_count}</td></tr>`
    )
    .join("");
}

function queueOffline(type, data, error) {
  state.offlineQueue.push({
    actionId: `Q-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
    type,
    data
  });
  localStorage.setItem("class_admin_offline_queue", JSON.stringify(state.offlineQueue));
  updateQueueBadge();
  toast(`${error.message}. Disimpan ke offline queue.`);
}

async function syncOfflineQueue() {
  if (!state.token || !state.offlineQueue.length) return;
  try {
    const result = await api("/api/offline/sync", "POST", { actions: state.offlineQueue });
    const failed = (result.data.results || []).filter((x) => !x.success).map((x) => x.actionId);
    state.offlineQueue = state.offlineQueue.filter((a) => failed.includes(a.actionId));
    localStorage.setItem("class_admin_offline_queue", JSON.stringify(state.offlineQueue));
    updateQueueBadge();
    toast(`Sync queue selesai. Sisa gagal: ${state.offlineQueue.length}`);
    await Promise.all([loadAttendance(), loadGrades(), loadJournals(), loadCounseling(), loadDashboard()]);
  } catch (error) {
    toast(`Sync gagal: ${error.message}`);
  }
}

function updateQueueBadge() {
  setText("queueCount", state.offlineQueue.length || 0);
}

async function api(url, method = "GET", body = null) {
  const headers = { "Content-Type": "application/json" };
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  const result = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : null
  });
  const json = await result.json().catch(() => ({}));
  if (!result.ok || json.ok === false) {
    throw new Error(json.message || "Request error");
  }
  return json;
}

async function downloadWithAuth(url, filename) {
  const headers = {};
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  const response = await fetch(url, { headers });
  if (!response.ok) {
    let message = "Download gagal";
    try {
      const json = await response.json();
      message = json.message || message;
    } catch (e) {}
    throw new Error(message);
  }
  const blob = await response.blob();
  const blobUrl = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = blobUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(blobUrl);
}

function setDefaultDates() {
  const today = new Date().toISOString().slice(0, 10);
  ["attendanceDate", "journalDate", "journalFilterDate", "counselingDate", "counselingFilterDate"].forEach((id) =>
    setVal(id, today)
  );
}

function populateMonthYear() {
  const month = new Date().getMonth() + 1;
  const year = new Date().getFullYear();
  qs("#recapMonth").innerHTML = Array.from({ length: 12 }, (_, i) => i + 1)
    .map((m) => `<option value="${m}" ${m === month ? "selected" : ""}>${String(m).padStart(2, "0")}</option>`)
    .join("");
  qs("#recapYear").innerHTML = [year - 1, year, year + 1]
    .map((y) => `<option value="${y}" ${y === year ? "selected" : ""}>${y}</option>`)
    .join("");
  setVal("gradeAcademicYear", defaultAcademicYear());
}

function defaultAcademicYear() {
  const d = new Date();
  const y = d.getFullYear();
  const m = d.getMonth() + 1;
  return m >= 7 ? `${y}/${y + 1}` : `${y - 1}/${y}`;
}

function toast(message) {
  const el = qs("#toast");
  el.textContent = message;
  el.classList.add("show");
  clearTimeout(window.__toastTimer);
  window.__toastTimer = setTimeout(() => el.classList.remove("show"), 2400);
}

function qs(selector) {
  return document.querySelector(selector);
}

function qsa(selector) {
  return Array.from(document.querySelectorAll(selector));
}

function val(id) {
  const el = qs(`#${id}`);
  return (el?.value || "").trim();
}

function setVal(id, value) {
  const el = qs(`#${id}`);
  if (el) el.value = value;
}

function setText(id, value) {
  const el = qs(`#${id}`);
  if (el) el.textContent = value;
}

function num(id) {
  const n = Number(val(id));
  return Number.isNaN(n) ? 0 : n;
}

function esc(v) {
  return String(v || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escJs(v) {
  return String(v || "").replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}
