import { describe, expect, it } from "vitest";
import { luhnValid, redactPii } from "@/lib/assistant/pii-filter";
import { serviceLogTail } from "@/lib/assistant/tools/panel";

// Personal identifiers in service logs are replaced before the model sees
// them (Stage 9 spec anti-goal); what a log needs to be read survives.
// Every value here is made up.

const redact = (text: string) => redactPii(text).text;

describe("redactPii: what it replaces", () => {
  it("emails", () => {
    expect(
      redact("login ok for budi.santoso+uat@example.invalid from web")
    ).toBe("login ok for [redacted email] from web");
    expect(redact('{"email":"a_b@mail.example.co.id"}')).toBe(
      '{"email":"[redacted email]"}'
    );
  });

  it("NIK: 16 digits with a plausible province, day and month", () => {
    expect(redact("nik=3201010101010001 rejected")).toBe(
      "nik=[redacted nik] rejected"
    );
    // A woman's NIK: day + 40.
    expect(redact("NIK 3174055508900002")).toBe("NIK [redacted nik]");
  });

  it("NPWP: 15 digits with or without punctuation, and the 16-digit form", () => {
    for (const npwp of [
      "01.234.567.8-901.234",
      "01 234 567 8 901 234",
      "012345678901234",
      "0012345678901234",
    ]) {
      expect(redact(`npwp: ${npwp} ok`), npwp).toBe("npwp: [redacted npwp] ok");
    }
  });

  it("Indonesian phone numbers in their usual forms", () => {
    for (const phone of [
      "081234567890",
      "0812-3456-7890",
      "0812 3456 7890",
      "+6281234567890",
      "+62 812-3456-7890",
      "6281234567890",
      "+62 21 5550 1234",
    ]) {
      expect(redact(`sms to ${phone} queued`), phone).toBe(
        "sms to [redacted phone] queued"
      );
    }
    expect(redact("call +14155550123 now")).toBe("call [redacted phone] now");
  });

  it("card numbers that pass the Luhn check, plain or grouped", () => {
    for (const card of [
      "4111111111111111",
      "4111 1111 1111 1111",
      "5500-0000-0000-0004",
      "378282246310005",
    ]) {
      expect(redact(`card ${card} declined`), card).toBe(
        "card [redacted card] declined"
      );
    }
  });

  it("counts what it replaced", () => {
    expect(
      redactPii("a@example.invalid 081234567890 4111111111111111").redacted
    ).toBe(3);
  });

  it("checks Luhn", () => {
    expect(luhnValid("4111111111111111")).toBe(true);
    expect(luhnValid("4111111111111112")).toBe(false);
  });
});

describe("redactPii: what survives", () => {
  it.each([
    "2026-11-20T04:31:01.123Z INFO started in 1234 ms",
    "2026-11-20 08:12:33,456 WARN pool 10/20",
    "[20/Nov/2026:08:12:33 +0700] GET /api/x 200 512",
    "request 0197f3a0-1b2c-7def-8000-081234567890 done",
    "commit 3f9a2c1d8e7b6a5f4e3d2c1b0a9f8e7d6c5b4a39",
    "listening on 0.0.0.0:8080, db at 10.0.0.5:5432",
    "Menara v1.23.4 (node 22.11.0, postgres 17.2)",
    "epoch 1763600000000 ms, 1763600000 s",
    "order 4111111111111112 (not a card: Luhn fails)",
    "port 3000 pid 81234 uptime 99.5%",
    "id 1234567890123456 offset 9876543210",
    "user@localhost logged in",
  ])("%s", (line) => {
    expect(redact(line)).toBe(line);
  });
});

describe("serviceLogTail", () => {
  it("redacts personal identifiers after the secret filter and counts both", () => {
    const tail = serviceLogTail(
      "2026-11-20T01:00:00Z user budi@example.invalid signed in\nDB_PASSWORD=hunter2hunter2\nnik 3201010101010001\n",
      200
    );
    expect(tail.log).not.toContain("budi@example.invalid");
    expect(tail.log).not.toContain("3201010101010001");
    expect(tail.log).not.toContain("hunter2");
    expect(tail.log).toContain("2026-11-20T01:00:00Z user [redacted email]");
    expect(tail.redacted).toBe(3);
  });
});
