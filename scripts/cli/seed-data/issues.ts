// Demo issues, milestones, labels and comments. The text is Indonesian
// because it stands in for what client staff and QA write; every person,
// client and number in it is fictional.
import type { IssuePriority, IssueStatus, IssueType } from "@/lib/db/schema";
import type { DemoEnvironmentSlug } from "./catalog";
import type { StaffHandle } from "./people";

/** A staff member, or one of the demo sign-in accounts. */
export type PersonRef =
  | StaffHandle
  | "demo-admin"
  | "demo-infra"
  | "demo-observer"
  | "demo-engineer"
  | "demo-qa"
  | "demo-ba"
  | "demo-staff";

export interface DemoComment {
  author: PersonRef;
  // Hours after the issue was created.
  afterHours: number;
  body: string;
}

export interface DemoIssue {
  number: number;
  title: string;
  description?: string;
  status: IssueStatus;
  type: IssueType;
  priority: IssuePriority;
  estimate?: number;
  createdBy?: PersonRef;
  assignee?: PersonRef;
  // Days before `now` the issue was opened.
  daysAgo?: number;
  milestone?: "past" | "next";
  labels?: readonly string[];
  // Number of the parent issue in the same project.
  parent?: number;
  environment?: DemoEnvironmentSlug;
  comments?: readonly DemoComment[];
}

export interface DemoMilestone {
  slot: "past" | "next";
  name: string;
  description: string;
  // Negative: in the past.
  dueInDays: number;
}

// Workspace-wide labels the demo issues use. The first six are the defaults
// every instance starts with; inserting them is a no-op unless one was
// deleted.
export const DEMO_LABELS = [
  { name: "bug", color: "#ef4444" },
  { name: "feature", color: "#3b82f6" },
  { name: "enhancement", color: "#22c55e" },
  { name: "question", color: "#a855f7" },
  { name: "blocked", color: "#f97316" },
  { name: "iuran", color: "#0ea5e9" },
  { name: "portal", color: "#8b5cf6" },
  { name: "laporan", color: "#14b8a6" },
] as const;

// The original four sample issues (no people attached), kept exactly as the
// first seed wrote them, for both demo projects.
export const ORIGINAL_ISSUES: readonly DemoIssue[] = [
  {
    number: 1,
    title: "Member import rejects empty rows",
    status: "open",
    type: "bug",
    priority: "high",
  },
  {
    number: 2,
    title: "Add a contribution summary report",
    status: "in_progress",
    type: "story",
    priority: "medium",
  },
  {
    number: 3,
    title: "Document the QA release checklist",
    status: "resolved",
    type: "task",
    priority: "low",
  },
  {
    number: 4,
    title: "Retire the old export endpoint",
    status: "closed",
    type: "task",
    priority: "low",
  },
];

// Added to DEMO and DEMOPORTAL: work assigned to the demo sign-in accounts,
// so demo-engineer and demo-qa find something in "assigned to me" and in
// their notifications.
const DEMO_ACCOUNT_ISSUES: readonly DemoIssue[] = [
  {
    number: 5,
    title: "Validasi NIK peserta saat registrasi",
    description:
      "NIK harus 16 digit angka. Saat ini form menerima huruf dan registrasi gagal di langkah terakhir tanpa pesan yang jelas.",
    status: "open",
    type: "bug",
    priority: "high",
    createdBy: "demo-qa",
    assignee: "demo-engineer",
    daysAgo: 3,
    labels: ["bug"],
    environment: "qa",
    comments: [
      {
        author: "demo-engineer",
        afterHours: 4,
        body: "Bisa direproduksi di QA. Validasi akan ditambahkan di backend dan form.",
      },
    ],
  },
  {
    number: 6,
    title: "Tes ulang ekspor rekap iuran bulanan",
    description:
      "Perbaikan pembulatan sudah di-deploy ke QA. Mohon dicek ulang dengan data bulan lalu.",
    status: "in_progress",
    type: "task",
    priority: "medium",
    createdBy: "demo-engineer",
    assignee: "demo-qa",
    daysAgo: 2,
    labels: ["iuran"],
    environment: "qa",
  },
  {
    number: 7,
    title: "Tombol unduh kartu peserta tidak merespons",
    description: "Di Firefox, klik tombol unduh tidak memulai unduhan PDF.",
    status: "resolved",
    type: "bug",
    priority: "medium",
    createdBy: "demo-qa",
    assignee: "demo-engineer",
    daysAgo: 9,
    labels: ["bug", "portal"],
    comments: [
      {
        author: "demo-engineer",
        afterHours: 20,
        body: "Penyebabnya popup blocker. Unduhan sekarang lewat link biasa, sudah di QA.",
      },
      {
        author: "demo-qa",
        afterHours: 30,
        body: "Sudah dicek di Firefox dan Chrome, aman.",
      },
    ],
  },
  {
    number: 8,
    title: "Siapkan data uji untuk demo klien",
    description:
      "Butuh 20 peserta fiktif dengan riwayat iuran 12 bulan di environment Demo.",
    status: "open",
    type: "task",
    priority: "low",
    createdBy: "demo-engineer",
    assignee: "demo-qa",
    daysAgo: 1,
    environment: "demo",
  },
];

export const DEMO_PROJECT_ISSUES: readonly DemoIssue[] = [
  ...ORIGINAL_ISSUES,
  ...DEMO_ACCOUNT_ISSUES,
];

export const MILESTONES: Record<string, readonly DemoMilestone[]> = {
  NPMB: [
    {
      slot: "past",
      name: "Rilis 1.3 — Iuran Oktober",
      description: "Perbaikan perhitungan iuran dan rekap bulanan.",
      dueInDays: -6,
    },
    {
      slot: "next",
      name: "Rilis 1.4 — Manfaat Pensiun",
      description: "Pengajuan dan simulasi manfaat pensiun.",
      dueInDays: 18,
    },
  ],
  NPCP: [
    {
      slot: "past",
      name: "Portal 2.0 — Login Baru",
      description: "Login dengan OTP email dan reset kata sandi.",
      dueInDays: -4,
    },
    {
      slot: "next",
      name: "Portal 2.1 — Klaim Online",
      description: "Peserta mengajukan klaim manfaat dari portal.",
      dueInDays: 24,
    },
  ],
  BSAC: [
    {
      slot: "past",
      name: "Tutup Buku Oktober",
      description: "Jurnal penyesuaian dan laporan bulanan Oktober.",
      dueInDays: -9,
    },
    {
      slot: "next",
      name: "Laporan Tahunan",
      description: "Persiapan laporan keuangan akhir tahun.",
      dueInDays: 30,
    },
  ],
};

export const PROJECT_ISSUES: Record<string, readonly DemoIssue[]> = {
  NPMB: [
    {
      number: 1,
      title: "Epic: Pengajuan manfaat pensiun",
      description:
        "Peserta yang memasuki usia pensiun dapat mengajukan manfaat dari aplikasi, termasuk simulasi dan unggah dokumen.",
      status: "in_progress",
      type: "epic",
      priority: "high",
      createdBy: "fajar",
      assignee: "fajar",
      daysAgo: 28,
      milestone: "next",
      labels: ["feature"],
    },
    {
      number: 2,
      title: "Simulasi manfaat pensiun berdasarkan saldo akhir",
      description:
        "Tampilkan estimasi manfaat bulanan dan sekaligus. Rumus mengikuti dokumen BA versi 3.",
      status: "in_progress",
      type: "story",
      priority: "high",
      estimate: 8,
      createdBy: "fajar",
      assignee: "ayu",
      daysAgo: 21,
      milestone: "next",
      labels: ["feature"],
      parent: 1,
      environment: "dev",
      comments: [
        {
          author: "ayu",
          afterHours: 26,
          body: "Rumus sudah diterapkan. Masih menunggu konfirmasi BA untuk pembulatan ke ribuan.",
        },
        {
          author: "gita",
          afterHours: 50,
          body: "Pembulatan ke bawah ke ribuan terdekat, sesuai contoh di lampiran.",
        },
        {
          author: "ayu",
          afterHours: 70,
          body: "Siap, sudah diubah dan di-deploy ke Dev.",
        },
      ],
    },
    {
      number: 3,
      title: "Unggah dokumen pendukung pengajuan manfaat",
      description:
        "KTP, kartu keluarga dan buku rekening, maksimal 5 MB per berkas.",
      status: "open",
      type: "story",
      priority: "medium",
      estimate: 5,
      createdBy: "fajar",
      assignee: "bima",
      daysAgo: 20,
      milestone: "next",
      labels: ["feature"],
      parent: 1,
      comments: [
        {
          author: "bima",
          afterHours: 20,
          body: "Batas ukuran berkas 5 MB sudah, format yang diterima PDF, JPG dan PNG.",
        },
      ],
    },
    {
      number: 4,
      title: "Total iuran bulanan selisih Rp1 pada rekap",
      description:
        "Rekap iuran Oktober untuk 3 perusahaan menampilkan total yang berbeda Rp1 dari jumlah per peserta.",
      status: "closed",
      type: "bug",
      priority: "urgent",
      createdBy: "citra",
      assignee: "bima",
      daysAgo: 26,
      milestone: "past",
      labels: ["bug", "iuran"],
      environment: "qa",
      comments: [
        {
          author: "bima",
          afterHours: 3,
          body: "Pembulatan dilakukan per baris, bukan di total. Sudah diperbaiki.",
        },
        {
          author: "citra",
          afterHours: 28,
          body: "Sudah dites ulang dengan data Oktober, total cocok.",
        },
      ],
    },
    {
      number: 5,
      title: "Impor peserta dari Excel gagal untuk tanggal lahir kosong",
      status: "resolved",
      type: "bug",
      priority: "high",
      createdBy: "gita",
      assignee: "ayu",
      daysAgo: 18,
      milestone: "past",
      labels: ["bug"],
      environment: "qa",
      comments: [
        {
          author: "ayu",
          afterHours: 5,
          body: "Baris dengan tanggal lahir kosong sekarang ditolak dengan pesan per baris, impor lainnya tetap jalan.",
        },
      ],
    },
    {
      number: 6,
      title: "Laporan peserta aktif per perusahaan",
      description: "Filter per perusahaan dan periode, ekspor ke Excel.",
      status: "resolved",
      type: "story",
      priority: "medium",
      estimate: 3,
      createdBy: "gita",
      assignee: "bima",
      daysAgo: 24,
      milestone: "past",
      labels: ["laporan"],
      comments: [
        {
          author: "gita",
          afterHours: 40,
          body: "Ekspor Excel sudah sesuai format dari BA.",
        },
      ],
    },
    {
      number: 7,
      title: "Perubahan data peserta perlu persetujuan supervisor",
      status: "open",
      type: "story",
      priority: "medium",
      estimate: 5,
      createdBy: "gita",
      assignee: "fajar",
      daysAgo: 12,
      milestone: "next",
      labels: ["enhancement"],
      comments: [
        {
          author: "fajar",
          afterHours: 6,
          body: "Perlu dipastikan dulu field apa saja yang butuh persetujuan.",
        },
        {
          author: "gita",
          afterHours: 30,
          body: "Nama, NIK, tanggal lahir dan rekening bank.",
        },
      ],
    },
    {
      number: 8,
      title: "Halaman detail peserta lambat untuk riwayat iuran panjang",
      description:
        "Peserta dengan lebih dari 200 transaksi iuran butuh 8 detik.",
      status: "in_progress",
      type: "bug",
      priority: "medium",
      createdBy: "citra",
      assignee: "bima",
      daysAgo: 8,
      labels: ["bug"],
      environment: "qa",
      comments: [
        {
          author: "bima",
          afterHours: 22,
          body: "Riwayat iuran akan dipaginasi, 50 per halaman.",
        },
      ],
    },
    {
      number: 9,
      title: "Notifikasi email saat iuran diterima",
      status: "open",
      type: "story",
      priority: "low",
      estimate: 3,
      createdBy: "gita",
      daysAgo: 6,
      labels: ["iuran", "feature"],
    },
    {
      number: 10,
      title: "Hitung ulang saldo setelah koreksi iuran",
      status: "resolved",
      type: "task",
      priority: "high",
      estimate: 2,
      createdBy: "fajar",
      assignee: "ayu",
      daysAgo: 15,
      milestone: "past",
      labels: ["iuran"],
      comments: [
        {
          author: "citra",
          afterHours: 48,
          body: "Saldo sudah benar setelah koreksi di QA.",
        },
      ],
    },
    {
      number: 11,
      title: "Format nomor peserta pada kartu tidak konsisten",
      status: "closed",
      type: "bug",
      priority: "low",
      createdBy: "gita",
      assignee: "ayu",
      daysAgo: 27,
      milestone: "past",
      labels: ["bug"],
      comments: [
        {
          author: "ayu",
          afterHours: 6,
          body: "Nomor peserta sekarang selalu 10 digit dengan nol di depan.",
        },
        {
          author: "gita",
          afterHours: 30,
          body: "Sudah sesuai di kartu dan di laporan.",
        },
      ],
    },
    {
      number: 12,
      title: "Apakah peserta pindahan perlu nomor baru?",
      description:
        "Untuk peserta pindahan dari DPLK lain, nomor lama disimpan atau dibuat baru?",
      status: "open",
      type: "task",
      priority: "medium",
      createdBy: "bima",
      assignee: "fajar",
      daysAgo: 4,
      labels: ["question", "blocked"],
      comments: [
        {
          author: "fajar",
          afterHours: 2,
          body: "Menunggu jawaban BA, sementara disimpan di field terpisah.",
        },
      ],
    },
    {
      number: 13,
      title: "Audit log perubahan data rekening",
      status: "open",
      type: "task",
      priority: "medium",
      estimate: 3,
      createdBy: "fajar",
      assignee: "bima",
      daysAgo: 5,
      milestone: "next",
      labels: ["enhancement"],
      parent: 1,
      comments: [
        {
          author: "bima",
          afterHours: 8,
          body: "Perubahan rekening dicatat beserta nilai lama, nilai baru dan pengubahnya.",
        },
      ],
    },
    {
      number: 14,
      title: "Perbarui data uji QA untuk rilis 1.4",
      status: "in_progress",
      type: "task",
      priority: "low",
      createdBy: "gita",
      assignee: "citra",
      daysAgo: 3,
      milestone: "next",
      environment: "qa",
      comments: [
        {
          author: "citra",
          afterHours: 3,
          body: "Data uji 1.4 akan memakai 30 peserta, 5 di antaranya sudah pensiun.",
        },
      ],
    },
    {
      number: 15,
      title: "Batas usia pensiun normal dibuat bisa diatur",
      status: "open",
      type: "story",
      priority: "medium",
      estimate: 2,
      createdBy: "gita",
      daysAgo: 2,
      labels: ["enhancement"],
    },
  ],
  NPCP: [
    {
      number: 1,
      title: "Epic: Klaim manfaat online dari portal",
      description:
        "Peserta mengajukan klaim, mengunggah dokumen dan memantau status dari portal.",
      status: "open",
      type: "epic",
      priority: "high",
      createdBy: "fajar",
      assignee: "fajar",
      daysAgo: 25,
      milestone: "next",
      labels: ["feature", "portal"],
    },
    {
      number: 2,
      title: "Form pengajuan klaim di portal",
      status: "in_progress",
      type: "story",
      priority: "high",
      estimate: 8,
      createdBy: "fajar",
      assignee: "dimas",
      daysAgo: 19,
      milestone: "next",
      labels: ["portal"],
      parent: 1,
      environment: "dev",
      comments: [
        {
          author: "dimas",
          afterHours: 30,
          body: "Form tiga langkah sudah di Dev, validasi rekening masih menunggu API.",
        },
        {
          author: "ayu",
          afterHours: 52,
          body: "Endpoint validasi rekening sudah tersedia di Dev.",
        },
      ],
    },
    {
      number: 3,
      title: "Status klaim ditampilkan sebagai linimasa",
      status: "open",
      type: "story",
      priority: "medium",
      estimate: 3,
      createdBy: "fajar",
      assignee: "hadi",
      daysAgo: 18,
      milestone: "next",
      labels: ["portal"],
      parent: 1,
      comments: [
        {
          author: "hadi",
          afterHours: 24,
          body: "Desain linimasa mengikuti mockup terbaru dari tim produk.",
        },
      ],
    },
    {
      number: 4,
      title: "OTP login tidak terkirim ke email kantor",
      description:
        "Beberapa peserta tidak menerima OTP. Tidak ada error di portal.",
      status: "closed",
      type: "bug",
      priority: "urgent",
      createdBy: "citra",
      assignee: "ayu",
      daysAgo: 27,
      milestone: "past",
      labels: ["bug", "portal"],
      environment: "qa",
      comments: [
        {
          author: "ayu",
          afterHours: 2,
          body: "Pengiriman ulang OTP gagal diam-diam saat antrean penuh. Sudah ditambah retry.",
        },
        {
          author: "citra",
          afterHours: 26,
          body: "OTP sekarang terkirim dalam beberapa detik.",
        },
      ],
    },
    {
      number: 5,
      title: "Reset kata sandi lewat email",
      status: "resolved",
      type: "story",
      priority: "high",
      estimate: 5,
      createdBy: "fajar",
      assignee: "dimas",
      daysAgo: 23,
      milestone: "past",
      labels: ["portal", "feature"],
      comments: [
        {
          author: "gita",
          afterHours: 60,
          body: "Link reset kedaluwarsa setelah 30 menit, sesuai spesifikasi.",
        },
      ],
    },
    {
      number: 6,
      title: "Saldo di dashboard tidak sama dengan mutasi",
      description:
        "Saldo dashboard memakai data H-1, mutasi memakai data terkini.",
      status: "in_progress",
      type: "bug",
      priority: "high",
      createdBy: "gita",
      assignee: "ayu",
      daysAgo: 7,
      labels: ["bug"],
      environment: "qa",
      comments: [
        {
          author: "ayu",
          afterHours: 18,
          body: "Dashboard akan memakai sumber yang sama dengan mutasi.",
        },
        {
          author: "gita",
          afterHours: 40,
          body: "Mohon kabari kalau sudah di QA, akan dites dengan 5 peserta uji.",
        },
      ],
    },
    {
      number: 7,
      title: "Tampilan mobile: tabel mutasi terpotong",
      status: "resolved",
      type: "bug",
      priority: "medium",
      createdBy: "citra",
      assignee: "hadi",
      daysAgo: 14,
      milestone: "past",
      labels: ["bug", "portal"],
      comments: [
        {
          author: "hadi",
          afterHours: 8,
          body: "Tabel diganti kartu di layar kecil.",
        },
      ],
    },
    {
      number: 8,
      title: "Unduh sertifikat kepesertaan dalam PDF",
      status: "open",
      type: "story",
      priority: "medium",
      estimate: 3,
      createdBy: "gita",
      assignee: "hadi",
      daysAgo: 10,
      labels: ["feature", "portal"],
      comments: [
        {
          author: "hadi",
          afterHours: 10,
          body: "Template PDF memakai format sertifikat yang sama dengan aplikasi admin.",
        },
        {
          author: "citra",
          afterHours: 36,
          body: "Mohon tambahkan nomor peserta di bagian atas.",
        },
      ],
    },
    {
      number: 9,
      title: "Pilihan bahasa Inggris di portal",
      status: "open",
      type: "story",
      priority: "low",
      estimate: 5,
      createdBy: "gita",
      daysAgo: 9,
      labels: ["enhancement"],
    },
    {
      number: 10,
      title: "Sesi berakhir terlalu cepat saat mengisi form",
      status: "open",
      type: "bug",
      priority: "medium",
      createdBy: "gita",
      assignee: "dimas",
      daysAgo: 5,
      labels: ["bug", "portal"],
      environment: "qa",
      comments: [
        {
          author: "dimas",
          afterHours: 4,
          body: "Batas sesi 15 menit tanpa aktivitas. Mengetik di form belum dihitung aktivitas.",
        },
      ],
    },
    {
      number: 11,
      title: "Grafik pertumbuhan saldo 12 bulan",
      status: "closed",
      type: "story",
      priority: "low",
      estimate: 3,
      createdBy: "gita",
      assignee: "hadi",
      daysAgo: 29,
      milestone: "past",
      labels: ["feature"],
      comments: [
        {
          author: "gita",
          afterHours: 50,
          body: "Grafik tampil benar untuk peserta dengan riwayat kurang dari 12 bulan.",
        },
      ],
    },
    {
      number: 12,
      title: "Kebijakan privasi perlu diperbarui di footer",
      status: "resolved",
      type: "task",
      priority: "low",
      createdBy: "gita",
      assignee: "dimas",
      daysAgo: 13,
      labels: ["portal"],
      comments: [
        {
          author: "dimas",
          afterHours: 4,
          body: "Teks kebijakan privasi diperbarui sesuai dokumen terbaru.",
        },
      ],
    },
    {
      number: 13,
      title: "Batasi percobaan login gagal",
      status: "in_progress",
      type: "task",
      priority: "high",
      estimate: 2,
      createdBy: "fajar",
      assignee: "ayu",
      daysAgo: 4,
      milestone: "next",
      labels: ["enhancement"],
      comments: [
        {
          author: "joko",
          afterHours: 6,
          body: "Kalau perlu batas per IP juga, kabari saja, bisa diatur di gateway.",
        },
      ],
    },
    {
      number: 14,
      title: "Uji regresi portal sebelum rilis 2.1",
      status: "open",
      type: "task",
      priority: "medium",
      createdBy: "gita",
      assignee: "citra",
      daysAgo: 2,
      milestone: "next",
      environment: "qa",
      comments: [
        {
          author: "citra",
          afterHours: 5,
          body: "Checklist regresi ada di knowledge base, akan dipakai untuk rilis ini.",
        },
      ],
    },
    {
      number: 15,
      title: "Ikon menu tidak muncul di Safari lama",
      status: "open",
      type: "bug",
      priority: "low",
      createdBy: "citra",
      daysAgo: 1,
      labels: ["bug"],
    },
  ],
  BSAC: [
    {
      number: 1,
      title: "Epic: Laporan keuangan tahunan",
      description:
        "Neraca, laporan aset neto dan perubahan aset neto untuk akhir tahun.",
      status: "open",
      type: "epic",
      priority: "high",
      createdBy: "fajar",
      assignee: "fajar",
      daysAgo: 22,
      milestone: "next",
      labels: ["laporan"],
    },
    {
      number: 2,
      title: "Laporan perubahan aset neto",
      status: "in_progress",
      type: "story",
      priority: "high",
      estimate: 8,
      createdBy: "fajar",
      assignee: "bima",
      daysAgo: 16,
      milestone: "next",
      labels: ["laporan"],
      parent: 1,
      comments: [
        {
          author: "bima",
          afterHours: 24,
          body: "Struktur laporan sudah, angka investasi masih dari data dummy.",
        },
        {
          author: "eka",
          afterHours: 48,
          body: "Format kolom pembanding tahun lalu belum ada.",
        },
      ],
    },
    {
      number: 3,
      title: "Neraca dengan kolom pembanding tahun lalu",
      status: "open",
      type: "story",
      priority: "medium",
      estimate: 5,
      createdBy: "fajar",
      assignee: "hadi",
      daysAgo: 15,
      milestone: "next",
      labels: ["laporan"],
      parent: 1,
      comments: [
        {
          author: "hadi",
          afterHours: 18,
          body: "Kolom pembanding mengambil saldo akhir tahun sebelumnya dari tutup buku.",
        },
      ],
    },
    {
      number: 4,
      title: "Jurnal penyesuaian tidak bisa disimpan bila memo kosong",
      status: "closed",
      type: "bug",
      priority: "high",
      createdBy: "eka",
      assignee: "bima",
      daysAgo: 28,
      milestone: "past",
      labels: ["bug"],
      environment: "qa",
      comments: [
        {
          author: "bima",
          afterHours: 3,
          body: "Memo sekarang opsional, sesuai SOP akuntansi.",
        },
      ],
    },
    {
      number: 5,
      title: "Tutup buku bulanan dengan validasi saldo",
      status: "resolved",
      type: "story",
      priority: "urgent",
      estimate: 5,
      createdBy: "fajar",
      assignee: "bima",
      daysAgo: 25,
      milestone: "past",
      labels: ["feature"],
      comments: [
        {
          author: "eka",
          afterHours: 72,
          body: "Tutup buku Oktober berhasil di QA, saldo awal November sesuai.",
        },
        {
          author: "gita",
          afterHours: 80,
          body: "Ditandai selesai, terima kasih.",
        },
      ],
    },
    {
      number: 6,
      title: "Impor mutasi bank format CSV",
      status: "in_progress",
      type: "story",
      priority: "medium",
      estimate: 5,
      createdBy: "eka",
      assignee: "hadi",
      daysAgo: 11,
      labels: ["enhancement"],
      comments: [
        {
          author: "hadi",
          afterHours: 10,
          body: "Mendukung pemisah koma dan titik koma, encoding UTF-8.",
        },
      ],
    },
    {
      number: 7,
      title: "Selisih kurs pada transaksi valas",
      status: "open",
      type: "bug",
      priority: "medium",
      createdBy: "eka",
      assignee: "bima",
      daysAgo: 9,
      labels: ["bug", "blocked"],
      comments: [
        {
          author: "bima",
          afterHours: 12,
          body: "Menunggu konfirmasi sumber kurs: kurs tengah atau kurs jual.",
        },
      ],
    },
    {
      number: 8,
      title: "Daftar akun (COA) bisa diekspor",
      status: "resolved",
      type: "task",
      priority: "low",
      estimate: 1,
      createdBy: "eka",
      assignee: "hadi",
      daysAgo: 19,
      milestone: "past",
      labels: ["laporan"],
      comments: [
        {
          author: "eka",
          afterHours: 26,
          body: "Ekspor COA sudah bisa dibuka di Excel tanpa masalah encoding.",
        },
      ],
    },
    {
      number: 9,
      title: "Hak akses approver jurnal",
      status: "open",
      type: "story",
      priority: "high",
      estimate: 3,
      createdBy: "fajar",
      assignee: "fajar",
      daysAgo: 7,
      milestone: "next",
      labels: ["enhancement"],
      comments: [
        {
          author: "fajar",
          afterHours: 12,
          body: "Approver ditentukan per jenis jurnal; perlu daftar dari tim akuntansi.",
        },
        {
          author: "eka",
          afterHours: 40,
          body: "Daftar approver sudah dikirim lewat email.",
        },
      ],
    },
    {
      number: 10,
      title: "Buku besar lambat untuk periode setahun",
      status: "in_progress",
      type: "bug",
      priority: "medium",
      createdBy: "gita",
      assignee: "bima",
      daysAgo: 6,
      labels: ["bug"],
      environment: "qa",
      comments: [
        {
          author: "joko",
          afterHours: 5,
          body: "Database QA sudah ditambah memori, coba dites lagi.",
        },
        {
          author: "gita",
          afterHours: 20,
          body: "Masih 12 detik, sepertinya butuh indeks.",
        },
      ],
    },
    {
      number: 11,
      title: "Nomor jurnal otomatis per bulan",
      status: "closed",
      type: "task",
      priority: "low",
      createdBy: "eka",
      assignee: "hadi",
      daysAgo: 29,
      milestone: "past",
      comments: [
        {
          author: "hadi",
          afterHours: 5,
          body: "Format nomor: JU/2026/11/0001, reset setiap bulan.",
        },
      ],
    },
    {
      number: 12,
      title: "Apakah laporan perlu tanda tangan digital?",
      status: "open",
      type: "task",
      priority: "low",
      createdBy: "hadi",
      daysAgo: 4,
      labels: ["question"],
    },
    {
      number: 13,
      title: "Rekonsiliasi bank otomatis",
      status: "open",
      type: "story",
      priority: "medium",
      estimate: 8,
      createdBy: "fajar",
      daysAgo: 3,
      labels: ["feature"],
    },
    {
      number: 14,
      title: "Tes tutup buku November",
      status: "open",
      type: "task",
      priority: "medium",
      createdBy: "gita",
      assignee: "eka",
      daysAgo: 2,
      milestone: "next",
      environment: "qa",
      comments: [
        {
          author: "eka",
          afterHours: 4,
          body: "Saldo awal November sudah disiapkan di QA.",
        },
      ],
    },
    {
      number: 15,
      title: "Cetak voucher jurnal ke PDF",
      status: "resolved",
      type: "story",
      priority: "low",
      estimate: 2,
      createdBy: "eka",
      assignee: "hadi",
      daysAgo: 12,
      labels: ["laporan"],
      comments: [
        {
          author: "eka",
          afterHours: 30,
          body: "Logo dan tanda tangan sudah muncul di PDF.",
        },
      ],
    },
  ],
};
