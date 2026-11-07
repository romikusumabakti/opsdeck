// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { IntlProvider } from "use-intl";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProvisioningStepSpec } from "@/lib/provisioning/plan";
import messages from "../messages/en.json";
import { WaitingForFirstBuild } from "../web/routes/$locale/_app/-components/env/deploys/deploys-client";
import type { ProvisioningLookups } from "../web/routes/$locale/_app/-components/env/provisioning-step-sentence";
import { SetupReview } from "../web/routes/$locale/_app/-components/setup/review";

const plan: ProvisioningStepSpec[] = [
  {
    kind: "prepare_deploy_dir",
    params: { serverId: "s1", deployDir: "/deployments/hris-staging" },
  },
  { kind: "deploy", params: { targetId: "hris", branch: "main" } },
];

const lookups: ProvisioningLookups = {
  serverLabel: (id) => (id === "s1" ? "app-server (.113)" : undefined),
  databaseHost: () => undefined,
  componentKey: (id) => id,
  tunnelName: () => undefined,
  policyName: () => undefined,
};

const creates = [
  "Environment Staging in HRIS",
  "Deploy target hris → app-server /deployments/hris-staging",
];

function review(
  props: Partial<React.ComponentProps<typeof SetupReview>> = {}
): React.ReactElement {
  return (
    <IntlProvider locale="en" messages={messages}>
      <SetupReview
        creates={creates}
        plan={plan}
        lookups={lookups}
        issues={[]}
        projectKey="HRIS"
        checking={false}
        submitting={false}
        onSubmit={() => {}}
        {...props}
      />
    </IntlProvider>
  );
}

const text = (html: string) => html.replace(/<[^>]+>/g, "");

describe("SetupReview", () => {
  it("lists what is created and the provisioning steps as sentences", () => {
    const out = text(renderToString(review()));
    for (const line of creates) expect(out).toContain(line);
    expect(out).toContain(
      "Prepare /deployments/hris-staging on app-server (.113)"
    );
    expect(out).toContain("Deploy the latest main build of hris");
  });

  it("renders each issue with its message and field", () => {
    const out = text(
      renderToString(
        review({
          issues: [
            { field: "name", code: "environmentNameTaken" },
            { field: "variables.SMTP_PASSWORD", code: "valueRequired" },
            { field: "services.backend", code: "placementServiceName" },
          ],
        })
      )
    );
    expect(out).toContain(
      "The project already has an environment with this name."
    );
    expect(out).toContain("variables.SMTP_PASSWORD");
    expect(out).toContain("Enter a value.");
    // The placement rule names the project's prefix.
    expect(out).toContain("start with hris-");
  });

  describe("Create & deploy", () => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    let container: HTMLDivElement;
    let root: ReturnType<typeof createRoot>;

    afterEach(() => {
      act(() => root.unmount());
      container.remove();
    });

    async function mount(
      props: Partial<React.ComponentProps<typeof SetupReview>>
    ) {
      container = document.createElement("div");
      document.body.append(container);
      root = createRoot(container);
      await act(async () => root.render(review(props)));
      return container.querySelector("button") as HTMLButtonElement;
    }

    it("submits when nothing is wrong", async () => {
      const onSubmit = vi.fn();
      const button = await mount({ onSubmit });
      expect(button.disabled).toBe(false);
      await act(async () => button.click());
      expect(onSubmit).toHaveBeenCalledOnce();
    });

    it("is disabled while an issue remains", async () => {
      const onSubmit = vi.fn();
      const button = await mount({
        onSubmit,
        issues: [{ field: "name", code: "environmentNameTaken" }],
      });
      expect(button.disabled).toBe(true);
      await act(async () => button.click());
      expect(onSubmit).not.toHaveBeenCalled();
    });

    it("is disabled while the preview is out of date and while creating", async () => {
      expect((await mount({ checking: true })).disabled).toBe(true);
      act(() => root.unmount());
      container.remove();
      expect((await mount({ submitting: true })).disabled).toBe(true);
    });
  });
});

describe("WaitingForFirstBuild", () => {
  it("names the branch the target waits for", () => {
    const out = text(
      renderToString(
        <IntlProvider locale="en" messages={messages}>
          <WaitingForFirstBuild branch="release/1.x" />
        </IntlProvider>
      )
    );
    expect(out).toContain("Waiting for the first build of release/1.x");
  });
});
