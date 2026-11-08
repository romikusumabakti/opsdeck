import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ db: {} }));

import type { DbTransaction } from "@/lib/db";
import { environmentDomains, environments } from "@/lib/db/schema";
import { saveDomainIn } from "@/lib/domains/repository";

const ENV_ID = "0197f3a0-1b2c-7def-8000-0123456789e1";

// A transaction that records the writes saveDomainIn makes. `upserted` is
// what the guarded upsert returns (none = the binding is provisioned).
function fakeTx(upserted: unknown[]) {
  const updates: { table: unknown; values: Record<string, unknown> }[] = [];
  const tx = {
    insert: (table: unknown) => {
      expect(table).toBe(environmentDomains);
      return {
        values: () => ({
          onConflictDoUpdate: () => ({ returning: async () => upserted }),
        }),
      };
    },
    update: (table: unknown) => ({
      set: (values: Record<string, unknown>) => ({
        where: async () => {
          updates.push({ table, values });
        },
      }),
    }),
  };
  return { tx: tx as unknown as DbTransaction, updates };
}

const tunnel = {
  kind: "tunnel" as const,
  hostname: "scmb-dev-2.dssconsulting.id",
  zoneId: "zone-row",
  remoteTunnelId: "rt-1",
  accessPolicyId: "pol",
};

describe("the environment URL follows its domain", () => {
  it("a changed label rewrites environments.url in the same transaction", async () => {
    const { tx, updates } = fakeTx([{ id: ENV_ID }]);
    expect(await saveDomainIn(tx, ENV_ID, tunnel)).toBe(true);
    expect(updates).toEqual([
      {
        table: environments,
        values: { url: "https://scmb-dev-2.dssconsulting.id" },
      },
    ]);
  });

  it("an external hostname sets its https URL, with the entry port", async () => {
    const { tx, updates } = fakeTx([{ id: ENV_ID }]);
    await saveDomainIn(
      tx,
      ENV_ID,
      {
        kind: "external",
        hostname: "app.example.com",
        zoneId: null,
        remoteTunnelId: null,
        accessPolicyId: null,
      },
      8104
    );
    expect(updates[0]?.values).toEqual({
      url: "https://app.example.com",
      entryPort: 8104,
    });
  });

  it("a provisioned binding writes nothing", async () => {
    const { tx, updates } = fakeTx([]);
    expect(await saveDomainIn(tx, ENV_ID, tunnel)).toBe(false);
    expect(updates).toEqual([]);
  });
});
