// Demo knowledge base: two collections of fictional Indonesian how-tos, in
// the editor's stored format (markdown). Links between documents use
// /knowledge/<slug>, which the seed turns into backlink rows like a save does.
import type { knowledgeDocTypeEnum } from "@/lib/db/schema";
import type { StaffHandle } from "./people";

type KnowledgeDocType = (typeof knowledgeDocTypeEnum.enumValues)[number];

export interface DemoCollection {
  name: string;
  description: string;
}

export interface DemoDocument {
  slug: string;
  collection: string;
  title: string;
  docType: KnowledgeDocType;
  author: StaffHandle;
  // Project key the document surfaces under, if any.
  project?: string;
  daysAgo: number;
  // False: a draft, visible to its author and admins only.
  published: boolean;
  content: string;
  // An earlier version, stored as a revision (the prior content an edit
  // replaced); `editor` made the edit that produced `content`.
  previous?: { title: string; content: string; editor: StaffHandle };
}

export const DEMO_COLLECTIONS: readonly DemoCollection[] = [
  {
    name: "Panduan Operasional",
    description: "Langkah kerja harian tim QA dan operasional (contoh fiktif).",
  },
  {
    name: "Catatan Teknis",
    description: "Catatan arsitektur dan keputusan teknis (contoh fiktif).",
  },
];

export const DEMO_DOCUMENTS: readonly DemoDocument[] = [
  {
    slug: "demo-alur-rilis-ke-qa",
    collection: "Panduan Operasional",
    title: "Alur rilis ke environment QA",
    docType: "runbook",
    author: "joko",
    daysAgo: 27,
    published: true,
    content: `# Alur rilis ke environment QA

Panduan ini menjelaskan cara memindahkan build terbaru ke environment **QA**.

## Sebelum deploy

1. Pastikan pipeline build berwarna hijau.
2. Cek tidak ada QA yang sedang menjalankan uji panjang.
3. Kunci environment bila perlu (menu *Deploy lock*).

## Deploy

1. Buka project, pilih environment **QA**.
2. Pilih komponen, lalu pilih tag build terbaru.
3. Klik **Deploy** dan pantau log sampai selesai.

## Setelah deploy

- Buka aplikasi dan pastikan halaman login tampil.
- Kabari tim QA di issue terkait.

Bila deploy gagal, ikuti [Menangani deploy yang gagal](/knowledge/demo-menangani-deploy-gagal).`,
    previous: {
      title: "Alur rilis ke QA",
      content: `# Alur rilis ke QA

1. Pastikan build hijau.
2. Deploy tag terbaru ke QA.
3. Kabari tim QA.`,
      editor: "gita",
    },
  },
  {
    slug: "demo-menangani-deploy-gagal",
    collection: "Panduan Operasional",
    title: "Menangani deploy yang gagal",
    docType: "runbook",
    author: "joko",
    daysAgo: 25,
    published: true,
    content: `# Menangani deploy yang gagal

## Langkah cepat

1. Buka log deploy dan cari baris pertama yang berisi \`error\`.
2. Bila health check gagal, cek apakah database environment hidup.
3. Lakukan **rollback** ke tag terakhir yang berhasil.

## Setelah rollback

- Catat penyebab di issue terkait.
- Tandai run yang gagal sebagai sudah ditangani (*acknowledge*).

> Jangan deploy ulang tag yang sama berkali-kali tanpa memperbaiki penyebabnya.`,
  },
  {
    slug: "demo-checklist-uji-regresi-portal",
    collection: "Panduan Operasional",
    title: "Checklist uji regresi portal peserta",
    docType: "doc",
    author: "gita",
    project: "NPCP",
    daysAgo: 14,
    published: true,
    content: `# Checklist uji regresi portal peserta

- [ ] Login dengan OTP email
- [ ] Reset kata sandi
- [ ] Dashboard saldo sama dengan mutasi
- [ ] Unduh sertifikat kepesertaan
- [ ] Tampilan mobile (lebar 375 px)
- [ ] Logout dan sesi berakhir

Gunakan peserta uji dari [Data uji standar](/knowledge/demo-data-uji-standar).`,
  },
  {
    slug: "demo-data-uji-standar",
    collection: "Panduan Operasional",
    title: "Data uji standar",
    docType: "doc",
    author: "citra",
    daysAgo: 20,
    published: true,
    content: `# Data uji standar

Semua data di bawah ini fiktif dan hanya ada di environment Dev dan QA.

| Peserta | Status | Catatan |
| --- | --- | --- |
| Peserta Uji 01 | Aktif | Iuran rutin 12 bulan |
| Peserta Uji 02 | Aktif | Ada koreksi iuran |
| Peserta Uji 03 | Pensiun | Untuk uji pengajuan manfaat |

Kata sandi peserta uji ada di pengelola password tim, bukan di dokumen ini.`,
  },
  {
    slug: "demo-perhitungan-iuran",
    collection: "Catatan Teknis",
    title: "Perhitungan dan pembulatan iuran",
    docType: "spec",
    author: "bima",
    project: "NPMB",
    daysAgo: 18,
    published: true,
    content: `# Perhitungan dan pembulatan iuran

## Aturan

- Iuran dihitung per peserta, lalu dibulatkan ke rupiah terdekat.
- Total rekap adalah **jumlah iuran yang sudah dibulatkan**, bukan total yang dibulatkan.

## Contoh

\`\`\`text
gaji pokok   : 7.250.000
persentase   : 5%
iuran        : 362.500
\`\`\`

## Kriteria penerimaan

- [x] Total rekap sama dengan jumlah per peserta
- [x] Koreksi iuran menghitung ulang saldo`,
    previous: {
      title: "Perhitungan iuran",
      content: `# Perhitungan iuran

Iuran = gaji pokok × persentase. Total rekap dibulatkan di akhir.`,
      editor: "ayu",
    },
  },
  {
    slug: "demo-struktur-environment",
    collection: "Catatan Teknis",
    title: "Struktur environment Dev, QA dan Demo",
    docType: "doc",
    author: "fajar",
    daysAgo: 29,
    published: true,
    content: `# Struktur environment Dev, QA dan Demo

| Environment | Branch | Dipakai oleh |
| --- | --- | --- |
| Dev | \`develop\` | Engineer |
| QA | branch rilis klien | Tim QA |
| Demo | branch rilis klien | Presentasi ke klien |

Setiap environment punya database sendiri. Data Demo boleh direset kapan saja.`,
  },
  {
    slug: "demo-rencana-migrasi-laporan",
    collection: "Catatan Teknis",
    title: "Rencana migrasi modul laporan (draf)",
    docType: "doc",
    author: "bima",
    project: "BSAC",
    daysAgo: 3,
    published: false,
    content: `# Rencana migrasi modul laporan (draf)

Catatan awal, belum dibahas dengan tim.

- Pisahkan query laporan dari transaksi harian.
- Pertimbangkan tabel ringkasan bulanan.`,
  },
];
