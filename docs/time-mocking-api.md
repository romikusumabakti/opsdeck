# Time Mocking API

REST API untuk mengontrol waktu sistem dalam lingkungan testing. Endpoint ini **hanya tersedia di environment non-produksi** (dev/staging/test).

- **Base URL:** `https://api.example.com/v1`
- **Auth:** `Authorization: Bearer <token>`
- **Content-Type:** `application/json`
- **Timestamp:** ISO 8601 UTC (`2026-05-11T10:30:00Z`)
- **Duration:** ISO 8601 (`PT1H30M`, `P1D`, `-PT15M`)

---

## Resource: Clock

State clock terdiri dari tiga field:

| Field    | Tipe    | Deskripsi                                          |
|----------|---------|----------------------------------------------------|
| `now`    | string  | Waktu saat ini (real atau mocked)                  |
| `mocked` | boolean | `true` jika waktu sedang di-override               |
| `frozen` | boolean | `true` jika waktu berhenti (tidak berjalan otomatis) |

---

## Endpoints

### `GET /clock`
Mengambil waktu clock saat ini.

**200 OK**
```json
{
  "now": "2026-05-11T10:30:00Z",
  "mocked": false,
  "frozen": false
}
```

---

### `POST /clock/travel`
Pindahkan waktu ke titik tertentu. Waktu tetap berjalan setelah pindah.

**Request**
```json
{ "target": "2030-01-01T00:00:00Z" }
```

**200 OK**
```json
{
  "now": "2030-01-01T00:00:00Z",
  "mocked": true,
  "frozen": false
}
```

---

### `POST /clock/freeze`
Bekukan waktu. Tanpa body → bekukan di waktu sekarang. Dengan `at` → bekukan di titik tertentu.

**Request** (opsional)
```json
{ "at": "2030-01-01T00:00:00Z" }
```

**200 OK**
```json
{
  "now": "2030-01-01T00:00:00Z",
  "mocked": true,
  "frozen": true
}
```

---

### `POST /clock/advance`
Geser waktu maju (atau mundur dengan durasi negatif). Hanya bisa dipanggil saat `frozen: true`.

**Request**
```json
{ "duration": "PT1H30M" }
```

**200 OK**
```json
{
  "now": "2030-01-01T01:30:00Z",
  "mocked": true,
  "frozen": true
}
```

**409 Conflict** — jika clock tidak dalam state `frozen`.

---

### `DELETE /clock`
Reset ke waktu real (unmock + unfreeze).

**204 No Content**

---

## Error Format (RFC 7807)

```json
{
  "type": "https://api.example.com/errors/invalid-duration",
  "title": "Invalid duration",
  "status": 400,
  "detail": "Duration 'foo' is not a valid ISO 8601 duration",
  "instance": "/v1/clock/advance"
}
```

| Status | Arti                                          |
|--------|-----------------------------------------------|
| 200    | Berhasil                                      |
| 204    | Berhasil tanpa body (reset)                   |
| 400    | Body / format tidak valid                     |
| 401    | Token hilang atau invalid                     |
| 403    | Dilarang di environment ini (mis. production) |
| 409    | State conflict (mis. `advance` saat tidak frozen) |

---

## Contoh Alur Testing

```http
POST /v1/clock/freeze
{ "at": "2026-01-01T00:00:00Z" }

# Jalankan test skenario "tahun baru"
POST /v1/clock/advance
{ "duration": "P30D" }

# Verifikasi behavior 30 hari kemudian
DELETE /v1/clock
```
