# Classroom Administration System (Apps Script + Spreadsheet)

## 1) Project Folder Structure

```text
gas-classroom-admin/
├─ appsscript.json
├─ Code.gs
├─ Index.html
├─ Styles.html
├─ ClientApp.html
├─ LoginView.html
├─ DashboardView.html
├─ StudentsView.html
├─ AttendanceView.html
├─ GradesView.html
├─ JournalView.html
├─ CounselingView.html
└─ README.md
```

## 2) Spreadsheet Schema (Google Spreadsheet as Database)

Gunakan satu Spreadsheet, lalu jalankan `setupSystem()` dari Apps Script. Sheet dan header dibuat otomatis:

### `Users`
- `user_id`
- `username`
- `full_name`
- `email`
- `role` (`admin` / `teacher`)
- `password_hash`
- `wa_number`
- `is_active`
- `last_login_at`
- `created_at`
- `updated_at`

### `Students`
- `student_id`
- `nisn`
- `full_name`
- `class_name`
- `gender`
- `parent_name`
- `parent_wa`
- `is_active`
- `qr_token`
- `created_at`
- `updated_at`

### `Attendance`
- `attendance_id`
- `date` (`yyyy-MM-dd`)
- `student_id`
- `status` (`hadir|sakit|izin|alfa`)
- `check_in_time`
- `is_late`
- `note`
- `source` (`qr_scan|qr_camera|manual`)
- `teacher_id`
- `created_at`
- `updated_at`

### `AttendanceRecapDaily`
- `date`
- `total_students`
- `hadir`
- `sakit`
- `izin`
- `alfa`
- `late_count`
- `present_rate`
- `updated_at`

### `Grades`
- `grade_id`
- `student_id`
- `subject`
- `objective_code`
- `objective_text`
- `nilai_harian`
- `nilai_tugas`
- `nilai_pts`
- `nilai_pas`
- `nilai_sikap`
- `nilai_produk`
- `final_score`
- `predicate`
- `semester`
- `academic_year`
- `teacher_id`
- `created_at`
- `updated_at`

### `Journal`
- `journal_id`
- `tanggal`
- `mata_pelajaran`
- `tujuan_pembelajaran`
- `materi`
- `kendala`
- `jam_waktu`
- `teacher_id`
- `created_at`

### `Counseling`
- `counseling_id`
- `tanggal`
- `student_id`
- `violation_type`
- `handling`
- `follow_up`
- `result`
- `teacher_id`
- `parent_notified`
- `created_at`

### `Settings`
- `key`
- `value`
- `updated_at`

### `AuditLog`
- `log_id`
- `event_type`
- `user_id`
- `payload_json`
- `created_at`

## 3) Main Features Covered

- Role-based access (`admin`, `teacher`)
- QR attendance scan + camera scanner + manual attendance edit
- Status: `hadir`, `sakit`, `izin`, `alfa`
- Late cutoff setting default `07:30` (from `Settings.LATE_TIME`)
- Daily and monthly attendance recap (month/year dropdown)
- Automatic WhatsApp notification after attendance scan
- Grade management with TP mapping and weighted auto calculation
- Grade export to new sheet in same spreadsheet
- Teaching journal module
- Counseling/violation log + WhatsApp parent notification
- Dashboard analytics
- Offline-safe queue on frontend (queued actions sync when online)
- QR generator for each student + batch QR generation

## 4) WhatsApp Integration Example

Set **Script Properties**:
- `WHATSAPP_API_URL`
- `WHATSAPP_API_TOKEN`
- `WHATSAPP_SENDER` (optional)

Example payload sent by backend:

```json
{
  "to": "6281234567890",
  "message": "Pemberitahuan Buku Konseling ...",
  "sender": "SCH-01"
}
```

Authorization header:

```text
Authorization: Bearer <WHATSAPP_API_TOKEN>
```

## 5) Deployment Instructions

1. Create Spreadsheet (or use existing), copy Spreadsheet ID.
2. Create Apps Script project.
3. Copy all files in folder ini ke Apps Script project (gunakan `clasp` atau manual).
4. Set Script Properties:
   - `SPREADSHEET_ID=<your_sheet_id>`
   - `WHATSAPP_API_URL=<provider_endpoint>` (optional)
   - `WHATSAPP_API_TOKEN=<token>` (optional)
   - `WHATSAPP_SENDER=<sender_id>` (optional)
5. Run function `setupSystem()` sekali.
6. Deploy:
   - Deploy > New deployment > Web app
   - Execute as: User accessing the web app
   - Access: sesuai kebutuhan (school domain / anyone with link)
7. Open web app URL.

## 6) Default Login

- Admin: `admin / admin123`
- Teacher: `guru1 / guru123`

Segera ganti password melalui fungsi `upsertUser`.

## 7) Production Notes

- **Performance**:
  - `CacheService` untuk users/students/settings.
  - Rekap harian ditulis incremental (`AttendanceRecapDaily`).
- **Concurrency**:
  - `LockService` dipakai saat write attendance.
- **Error handling**:
  - Semua endpoint public dibungkus `withGuard_`.
- **Scalability**:
  - Sheet schema modular per domain data.
  - Frontend dipisah per module HTML + 1 controller JS.
- **Offline-safe**:
  - Aksi penting ditaruh ke local queue dan sync ulang via `syncOfflineQueue`.
