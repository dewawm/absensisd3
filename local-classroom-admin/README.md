# Local Classroom Admin (VS Code + Localhost)

Versi ini **tanpa Google Apps Script**. Seluruh sistem berjalan lokal:

- Backend: Node.js + Express
- Database: SQLite (`better-sqlite3`)
- Frontend: HTML/CSS/JavaScript
- Notification: WhatsApp API (opsional, via `.env`)

## Jalankan di Localhost

1. Buka folder `local-classroom-admin` di VS Code.
2. Install dependency:

```bash
npm install
```

3. Buat file `.env` dari template:

```bash
cp .env.example .env
```

4. Start server:

```bash
npm run dev
```

5. Buka browser:

```text
http://localhost:3000
```

## Default Login

- Admin: `admin` / `admin123`
- Teacher: `guru1` / `guru123`

## Struktur Proyek

```text
local-classroom-admin/
├─ client/
│  ├─ index.html
│  ├─ styles.css
│  └─ app.js
├─ server/
│  ├─ app.js
│  ├─ config.js
│  ├─ db.js
│  ├─ utils.js
│  ├─ middleware/
│  │  └─ auth.js
│  ├─ routes/
│  │  └─ api.js
│  └─ services/
│     └─ whatsappService.js
├─ data/
│  └─ classroom.db (auto-generated saat run)
├─ .env.example
├─ package.json
└─ README.md
```

## Modul yang Tersedia

1. Dashboard analytics.
2. QR Attendance:
   - scan via input/kamera
   - status hadir/sakit/izin/alfa
   - late cutoff (`LATE_CUTOFF`, default 07:30)
   - rekap harian dan bulanan
   - notifikasi WA ke orang tua
3. Attendance management manual edit.
4. Manajemen nilai:
   - mapel: Matematika, IPAS, Bahasa Indonesia, Bahasa Bali, SBdP
   - TP (tujuan pembelajaran)
   - kategori nilai: harian, tugas, PTS, PAS, sikap, produk
   - auto final score + predikat
   - export CSV
5. Jurnal mengajar.
6. Buku konseling + WA notifikasi.
7. Role-based access (`admin`, `teacher`).
8. Offline-safe queue di frontend (sync saat online).

## WhatsApp API (Opsional)

Isi `.env`:

```env
WA_API_URL=https://your-provider/send
WA_API_TOKEN=your_token
WA_SENDER=SCH-01
```

Jika kosong, sistem tetap jalan, hanya pengiriman WA otomatis akan di-skip.

## Catatan

- Database tersimpan lokal di `data/classroom.db`.
- Sistem siap diedit penuh dari VS Code (backend + frontend).
- Untuk produksi, ganti `JWT_SECRET`, gunakan HTTPS, dan harden auth + logging.
