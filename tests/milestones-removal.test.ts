import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { issueInputSchema, issueUpdateSchema } from "@/lib/validation";

const ID = "0197f3a0-1b2c-7def-8000-0123456789a1";

describe("milestones removal", () => {
  it("an old client's milestoneId is accepted and dropped", () => {
    const created = issueInputSchema.parse({
      projectId: ID,
      title: "t",
      milestoneId: ID,
    });
    expect(created).not.toHaveProperty("milestoneId");
    const updated = issueUpdateSchema.safeParse({ milestoneId: null });
    expect(updated.success).toBe(true);
    expect(updated.data).not.toHaveProperty("milestoneId");
  });

  it("the milestone modules are gone", () => {
    for (const f of [
      "server/routes/milestones.ts",
      "server/services/milestones.ts",
      "web/api/milestones.ts",
      "web/routes/$locale/_app/-components/project/milestones-client.tsx",
    ]) {
      expect(existsSync(f), f).toBe(false);
    }
    expect(readFileSync("server/services/issues.ts", "utf8")).not.toMatch(
      /milestone/i
    );
  });
});
