# Time Mocking API

A small REST contract that lets OpsDeck move an application's clock in a test
environment. QA uses it to test month-end, interest, expiry and other
date-driven rules without waiting for the calendar.

Your application implements the endpoints below; OpsDeck calls them. Expose
them **only in non-production environments** (dev, QA, UAT).

- **Clock URL:** the full URL of the `/clock` resource below (e.g.
  `https://api.example.com/v1/clock`), set per environment in its settings,
  tab "Mail & Mock time". OpsDeck appends `/travel`, `/freeze` and
  `/advance` to it.
- **Auth:** `X-Api-Key: <key>`, sent when a key is set for the environment.
- **Content-Type:** `application/json`
- **Timestamps:** ISO 8601 UTC (`2026-05-11T10:30:00Z`)
- **Durations:** ISO 8601 (`PT1H30M`, `P1D`, `-PT15M`)

---

## Resource: Clock

The clock state has three fields:

| Field    | Type    | Description                                        |
|----------|---------|----------------------------------------------------|
| `now`    | string  | The current time (real or mocked)                  |
| `mocked` | boolean | `true` while the time is overridden                |
| `frozen` | boolean | `true` while the time stands still                 |

---

## Endpoints

### `GET /clock`

Returns the current clock state.

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

Moves the clock to a point in time. The clock keeps running from there.

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

Stops the clock. Without a body it freezes at the current time; with `at` it
freezes at that point.

**Request** (optional)
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

Moves a frozen clock forward, or back with a negative duration. Only valid
while `frozen` is `true`.

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

**409 Conflict** when the clock is not frozen.

---

### `DELETE /clock`

Returns to real time (unmocks and unfreezes).

**204 No Content**

---

## Error format (RFC 7807)

```json
{
  "type": "https://api.example.com/errors/invalid-duration",
  "title": "Invalid duration",
  "status": 400,
  "detail": "Duration 'foo' is not a valid ISO 8601 duration",
  "instance": "/v1/clock/advance"
}
```

OpsDeck shows `title` and `detail` to the user when a call fails.

| Status | Meaning                                              |
|--------|------------------------------------------------------|
| 200    | Success                                              |
| 204    | Success with no body (reset)                         |
| 400    | Invalid body or format                               |
| 401    | Missing or invalid API key                           |
| 403    | Not allowed in this environment (e.g. production)    |
| 409    | State conflict (e.g. `advance` while not frozen)     |

---

## Example test flow

```http
POST /v1/clock/freeze
{ "at": "2026-01-01T00:00:00Z" }

# Run the "new year" scenario
POST /v1/clock/advance
{ "duration": "P30D" }

# Check the behaviour 30 days later
DELETE /v1/clock
```

---

## Implementing the contract

The contract only works if the application reads time from one place it
controls, instead of calling the system clock directly. One way to do that:

1. Route every read of "now" through a single clock object: `java.time.Clock`
   injected as a bean in Spring, `TimeProvider` in .NET 8+, or a small
   `now()` module in Node or Python. Database defaults such as `now()` or
   `CURRENT_TIMESTAMP` bypass it, so pass the time from the application
   instead.
2. Keep the mock state (an offset from real time, or a frozen instant) in
   that object. `travel` sets the offset, `freeze` pins the instant,
   `advance` moves the pinned instant, and `DELETE` clears both.
3. If several instances run, keep the state somewhere they share (a table or
   a cache key) so they all agree on the time.
4. Register the endpoints only when a test profile is active, and return 403
   otherwise. A production build should not contain them.

Scheduled jobs that fire at a wall-clock time (cron expressions, Quartz
triggers) don't fire just because the mocked time passes their trigger.
Expose a way to run them on demand, or have them check the mocked clock.

## Without the API: legacy mode

When an environment has no clock URL, OpsDeck falls back to changing the
backend server's system clock over SSH: it stops NTP (`timedatectl set-ntp
false`, chronyd, systemd-timesyncd), sets the time with `date -u -s`, and
restarts the backend service. Reset turns NTP back on and forces a resync.

Legacy mode needs root on the server and moves the clock for everything on
it, so use it only for a backend that has the server to itself.
