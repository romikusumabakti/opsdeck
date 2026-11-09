import { expect, it, vi } from "vitest";

const upsert = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("ioredis", () => ({ default: class {} }));
vi.mock("bullmq", () => ({
  Queue: class {
    upsertJobScheduler = upsert;
  },
}));

process.env.REDIS_URL ??= "redis://test";
const { scheduleInstanceBackup, scheduleInstanceUpdateCheck } = await import(
  "@/lib/queue"
);

it("registers one daily scheduler in the instance time zone", async () => {
  await scheduleInstanceBackup("03:15", "Asia/Jakarta");
  await scheduleInstanceBackup("04:00", "Asia/Jakarta");
  expect(upsert).toHaveBeenNthCalledWith(
    1,
    "instance-backup",
    { pattern: "15 3 * * *", tz: "Asia/Jakarta" },
    expect.objectContaining({
      name: "instance/backup.run",
      data: { trigger: "schedule" },
    })
  );
  // Same scheduler id: the second call replaces the first schedule.
  expect(upsert).toHaveBeenNthCalledWith(
    2,
    "instance-backup",
    { pattern: "0 4 * * *", tz: "Asia/Jakarta" },
    expect.anything()
  );
});

it("registers the hourly update check on the hour, under one id", async () => {
  upsert.mockClear();
  await scheduleInstanceUpdateCheck("Asia/Jakarta");
  await scheduleInstanceUpdateCheck("Asia/Jakarta");
  expect(upsert).toHaveBeenCalledTimes(2);
  for (const call of upsert.mock.calls as unknown[][]) {
    expect(call).toEqual([
      "instance-update-check",
      { pattern: "0 * * * *", tz: "Asia/Jakarta" },
      expect.objectContaining({
        name: "instance/update.check",
        data: {},
        opts: expect.objectContaining({ attempts: 1 }),
      }),
    ]);
  }
});
