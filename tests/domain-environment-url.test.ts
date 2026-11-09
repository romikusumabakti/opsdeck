import { describe, expect, it, vi } from "vitest";

// saveDomain and adoptDomain run in db.transaction under the teardown guard.
const guard = vi.hoisted(() => ({
  tx: null as unknown,
  tearingDown: false,
  calls: [] as string[],
}));
vi.mock("@/lib/db", () => ({
  db: { transaction: (fn: (tx: unknown) => unknown) => fn(guard.tx) },
}));
vi.mock("@/lib/teardown/guard", () => ({
  holdEnvironmentShared: vi.fn(async (_tx: unknown, id: string) => {
    guard.calls.push(`hold ${id}`);
  }),
  teardownBlocks: vi.fn(async (id: string, tx: unknown) => {
    expect(tx).toBe(guard.tx);
    guard.calls.push(`check ${id}`);
    return guard.tearingDown;
  }),
}));

import type { DbTransaction } from "@/lib/db";
import { environmentDomains, environments } from "@/lib/db/schema";
import {
  adoptDomain,
  saveDomain,
  saveDomainIn,
} from "@/lib/domains/repository";

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
          onConflictDoNothing: () => ({ returning: async () => upserted }),
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

describe("domain writes and a teardown", () => {
  const adopted = {
    ...tunnel,
    accessPolicyId: null,
    accessAppId: "app-1",
    dnsRecordId: "rec-1",
  };

  it("saveDomain and adoptDomain write under the shared environment lock", async () => {
    guard.tearingDown = false;
    for (const write of [
      () => saveDomain(ENV_ID, tunnel),
      () => adoptDomain(ENV_ID, adopted),
    ]) {
      guard.calls = [];
      const { tx, updates } = fakeTx([{ id: ENV_ID }]);
      guard.tx = tx;
      expect(await write()).toBe("saved");
      expect(guard.calls).toEqual([`hold ${ENV_ID}`, `check ${ENV_ID}`]);
      expect(updates[0]?.values).toEqual({
        url: "https://scmb-dev-2.dssconsulting.id",
      });
    }
  });

  it("write nothing while a teardown is under way", async () => {
    guard.tearingDown = true;
    for (const write of [
      () => saveDomain(ENV_ID, tunnel),
      () => adoptDomain(ENV_ID, adopted),
    ]) {
      const { tx, updates } = fakeTx([{ id: ENV_ID }]);
      guard.tx = {
        ...(tx as object),
        insert: () => {
          throw new Error("must not insert");
        },
      };
      expect(await write()).toBe("tearingDown");
      expect(updates).toEqual([]);
    }
  });

  it("adoptDomain reports an existing binding as provisioned", async () => {
    guard.tearingDown = false;
    const { tx, updates } = fakeTx([]);
    guard.tx = tx;
    expect(await adoptDomain(ENV_ID, adopted)).toBe("provisioned");
    expect(updates).toEqual([]);
  });
});
