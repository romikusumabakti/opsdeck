# Sign in with Microsoft (Azure Entra ID)

Panduan setup login Microsoft untuk OpsDeck. Fitur ini **opsional** — tombol
"Sign in with Microsoft" hanya muncul di halaman sign-in jika ketiga variabel
`MICROSOFT_*` terisi.

Implementasi memakai [better-auth](https://better-auth.com) social provider
`microsoft`. Endpoint callback disediakan otomatis oleh route
`app/api/auth/[...all]/route.ts`.

---

## Model akses: gerbangnya di Entra, bukan di OpsDeck

Microsoft sign-in **membuat user baru secara otomatis** pada login pertama
(`disableSignUp: false`). Tidak perlu undangan lebih dulu.

Keputusan siapa yang boleh masuk sengaja ditaruh di Entra, bukan di tabel
OpsDeck. Alasannya lifecycle: kalau daftar aksesnya undangan, orang yang resign
tetap punya akun sampai ada yang ingat menghapusnya. Kalau gerbangnya Entra,
offboarding oleh IT otomatis mematikan login — satu sumber kebenaran yang
memang sudah dikelola.

Tiga lapis yang membatasi:

1. **App assignment di Entra** — `User assignment required = Yes` + assign grup
   karyawan. Ini kunci utamanya (lihat langkah 2 di bawah).
2. **Filter domain di aplikasi** — hook `databaseHooks.user.create.before` di
   `lib/auth.ts` menolak email apa pun di luar `ALLOWED_EMAIL_DOMAIN`. Berlaku
   untuk semua jalur pembuatan user, jadi tetap menahan meski app assignment di
   Azure lupa dinyalakan. Ditolak → `/sign-in?error=domain_not_allowed`.
3. **Role default `viewer`** — user hasil OAuth cuma dapat capability `read`
   (lihat `lib/roles.ts`). Tidak bisa edit issue, edit KB, apalagi ops. Admin
   menaikkan role lewat halaman Users.

Kalau user dengan email tersebut sudah ada (dari `/setup` atau undangan), akun
Microsoft di-*link* ke user itu — baris baru di tabel `accounts` dengan
`provider_id = 'microsoft'` — dan role yang sudah ada **tidak diubah**. Login
berikutnya langsung memakai link tersebut.

Undangan tetap dipertahankan untuk orang yang perlu role `member`,
`maintainer`, atau `admin` sejak awal, dan untuk yang login pakai password.

> **Konsekuensi yang harus diterima:** siapa pun di grup Entra yang di-assign
> bisa membaca seluruh knowledge base, semua issue, dan dashboard environment.
> Kalau ada isi KB yang tidak boleh dibaca semua karyawan, jangan pakai pola
> ini — set `disableSignUp: true` pada provider `microsoft` dan kembali ke
> invite-only.

---

## 1. Ambil kredensial dari Azure portal

**Entra ID → App registrations → pilih aplikasi** (atau *New registration*).

Halaman **Overview**:

| Nilai di portal              | Variabel env              |
| ---------------------------- | ------------------------- |
| Application (client) ID       | `MICROSOFT_CLIENT_ID`     |
| Directory (tenant) ID         | `MICROSOFT_TENANT_ID`     |

**Certificates & secrets → Client secrets → New client secret**:

- Salin kolom **Value**, bukan **Secret ID** → `MICROSOFT_CLIENT_SECRET`.
- Value hanya tampil sekali. Catat juga tanggal kedaluwarsanya — client secret
  punya masa berlaku (maks. 24 bulan) dan login akan gagal setelah lewat.

---

## 2. Batasi siapa yang boleh memakai aplikasi

**Wajib.** Karena OpsDeck memprovisioning user secara otomatis, daftar siapa
yang boleh masuk dikelola di sini.

**Entra ID → Enterprise applications → pilih aplikasi → Properties**:

- **Assignment required?** → **Yes** → Save.

Lalu **Users and groups → Add user/group** → assign grup karyawan (mis. semua
staf, atau grup khusus tim ops).

Tanpa langkah ini, semua akun di direktori bisa lolos — dan yang menahan tinggal
filter domain di aplikasi.

---

## 3. Daftarkan redirect URI

Ini langkah yang paling sering terlewat. Gejalanya:

```
AADSTS50011: The redirect URI 'http://localhost:3000/api/auth/callback/microsoft'
specified in the request does not match the redirect URIs configured for the
application '<client-id>'.
```

**Authentication → Add a platform → Web** (bukan *Single-page application* —
SPA menolak alur confidential client yang memakai client secret).

Tambahkan URI berikut, lalu **Configure** → **Save**:

```
http://localhost:3000/api/auth/callback/microsoft
https://<SITE_ADDRESS>/api/auth/callback/microsoft
```

Aturan:

- Formatnya selalu `<BETTER_AUTH_URL>/api/auth/callback/microsoft`.
- Harus sama persis: skema, host, port, tanpa trailing slash.
- `http://localhost` diizinkan Entra tanpa TLS. Host lain wajib `https`.
- Perubahan butuh beberapa detik sampai ±1 menit untuk propagasi.

---

## 4. Pastikan klaim `email` ada

Provider membaca klaim `email` dari ID token. Jika user di direktori tidak punya
atribut `mail`, klaim tersebut kosong dan callback gagal dengan
`error=email_not_found`.

**Token configuration → Add optional claim → ID → centang `email` → Add.**

Kalau Azure menawarkan untuk menambahkan Microsoft Graph permission
`email`, setujui.

---

## 5. Isi environment variable

Host (`pnpm dev`) → `.env.local`. Docker Compose → `.env`.

```bash
MICROSOFT_CLIENT_ID=<Application (client) ID>
MICROSOFT_TENANT_ID=<Directory (tenant) ID>
MICROSOFT_CLIENT_SECRET=<Value dari client secret>
```

Restart aplikasi setelah mengubahnya.

> **Ketiganya wajib diisi bersamaan.** Kalau hanya sebagian yang di-set,
> aplikasi sengaja gagal saat boot. Tanpa `MICROSOFT_TENANT_ID`, better-auth
> memakai authority `common` yang menerima **akun Microsoft apa pun** —
> termasuk akun pribadi di luar direktori. Karena provider ini dipercaya untuk
> account linking (lihat bawah), akun asing yang kebetulan memakai alamat email
> user OpsDeck bisa ikut ter-link. Menyetel tenant ID mengunci login hanya ke
> direktori kita.

Untuk mengosongkan fitur ini lagi, kosongkan ketiganya — tombol otomatis hilang.

---

## 6. Verifikasi

```bash
curl -s -X POST http://localhost:3000/api/auth/sign-in/social \
  -H 'Content-Type: application/json' \
  -d '{"provider":"microsoft","callbackURL":"/","errorCallbackURL":"/sign-in"}'
```

Respons yang benar berisi `url` ke
`https://login.microsoftonline.com/<tenant-id>/oauth2/v2.0/authorize?...`
dengan `redirect_uri` yang sudah di-encode. Kalau tenant ID di URL itu
`common`, berarti `MICROSOFT_TENANT_ID` belum terbaca.

Lalu buka `/sign-in` di browser dan klik tombolnya.

---

## Kode error

better-auth mengembalikan user ke `/sign-in?error=<code>` saat callback gagal.
Pemetaan ke pesan UI ada di `oauthErrorKey()` pada
`app/[locale]/sign-in/sign-in-form.tsx`; teksnya di `messages/*.json` (`signIn.*`).

| Code                                     | Arti                                                                  |
| ---------------------------------------- | --------------------------------------------------------------------- |
| `domain_not_allowed`                     | Email di luar `ALLOWED_EMAIL_DOMAIN` — ditolak hook di `lib/auth.ts`.  |
| `signup_disabled`                        | Hanya muncul kalau `disableSignUp` dinyalakan lagi (mode invite-only). |
| `account_not_linked`                     | User ada tapi tidak boleh di-link (lihat catatan account linking).     |
| `unable_to_link_account`                 | Gagal menulis baris `accounts` — cek log server.                       |
| `email_not_found`                        | Entra tidak mengirim klaim `email` — lihat langkah 4.                  |
| `account_already_linked_to_different_user` | Akun Microsoft itu sudah ter-link ke user lain.                      |
| `invalid_code` / `no_code`               | Alur OAuth terputus; ulangi login.                                     |

Error `AADSTS*` berasal dari Azure, bukan dari aplikasi — user tidak pernah
sampai ke callback. `AADSTS50011` = redirect URI (langkah 3),
`AADSTS7000215` = client secret salah/kedaluwarsa (langkah 1).

---

## Catatan account linking

Konfigurasi di `lib/auth.ts`:

```ts
account: {
  accountLinking: {
    enabled: true,
    trustedProviders: ["microsoft"],
    allowDifferentEmails: false,
  },
},
```

- `trustedProviders` diperlukan karena Entra tidak mengirim `email_verified`
  kecuali optional claim-nya dikonfigurasi. Tanpa ini, login pertama user yang
  sudah ada akan gagal dengan `account_not_linked`. Ini aman **hanya karena**
  `tenantId` mengunci login ke direktori kita sendiri, yang memang pemilik
  alamat email yang diklaimnya.
- `allowDifferentEmails: false` — identitas Microsoft hanya boleh menempel ke
  user dengan email yang sama.
- better-auth juga mensyaratkan `users.email_verified = true` di sisi lokal.
  Semua user OpsDeck dibuat dengan `emailVerified: true` (lihat
  `actions/users.ts`), jadi tidak perlu konfigurasi tambahan.

---

## Catatan role default

`admin({ defaultRole: ROLE_VIEWER })` di `lib/auth.ts` adalah role untuk user
yang tidak diberi role secara eksplisit — dalam praktiknya hanya jalur Microsoft
sign-in.

Hook plugin `admin` menulis `{ role: defaultRole, ...user }` dengan `...user`
di belakang, jadi role eksplisit selalu menang. Kedua jalur server action
(`createInitialUser` → `admin`, `acceptInvitation` → role dari undangan) mengirim
role eksplisit, sehingga tidak terpengaruh.

Hasil akhir per jalur:

| Jalur                  | Role hasil |
| ---------------------- | ---------- |
| Microsoft sign-in baru | `viewer`   |
| `/setup` (user pertama)| `admin`    |
| Terima undangan        | sesuai undangan (`member` / `admin`) |
| Microsoft sign-in ke user yang sudah ada | tidak berubah |

Halaman **Users** memakai menu role berisi keempat role (`ASSIGNABLE_ROLES` di
`lib/roles.ts`), bukan lagi tombol toggle admin ↔ member — kalau tetap toggle,
user `viewer` hasil OAuth akan langsung melompat jadi `admin` dalam satu klik.
Form undangan tetap menawarkan `member` / `admin` saja.

---

## Rotasi client secret

Client secret Entra punya masa berlaku. Sebelum kedaluwarsa:

1. **Certificates & secrets → New client secret**, salin Value-nya.
2. Update `MICROSOFT_CLIENT_SECRET` di `.env.local` / `.env`.
3. Restart aplikasi, tes login.
4. Hapus secret lama di portal.

Secret tidak boleh masuk ke git — `.gitignore` sudah memblokir semua `.env*`
kecuali `.env.example`. Kalau sebuah secret pernah bocor (ter-commit, terkirim
di chat, atau masuk log), rotasi adalah satu-satunya perbaikan; secret itu
harus dihapus dari portal.

---

## Berkas terkait

| Berkas                                   | Isi                                                       |
| ---------------------------------------- | --------------------------------------------------------- |
| `lib/auth.ts`                            | Konfigurasi provider, account linking, rate limit          |
| `app/[locale]/sign-in/page.tsx`          | Membaca `MICROSOFT_AUTH_ENABLED` dan `?error=`             |
| `app/[locale]/sign-in/sign-in-form.tsx`  | Tombol, logo, pemetaan error                               |
| `app/api/auth/[...all]/route.ts`         | Handler callback better-auth                               |
| `messages/{ar,en,id,zh}.json`            | Teks `signIn.microsoft*` dan `signIn.errorMicrosoft*`      |
| `.env.example`, `compose.yaml`           | Deklarasi variabel env                                     |
