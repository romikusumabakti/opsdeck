import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToString } from "react-dom/server";
import { IntlProvider } from "use-intl";
import { describe, expect, it, vi } from "vitest";
import { ProjectRoleProvider } from "@/components/project-role";
import messages from "../messages/en.json";

vi.mock("@/i18n/navigation", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  Link: ({ href, children }: { href: string; children?: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));
vi.mock("@/web/api/apps", () => ({ startComponentBuild: vi.fn() }));
vi.mock("@/components/live-run-dialog", () => ({ LiveRunDialog: () => null }));
vi.mock(
  "../web/routes/$locale/_app/-components/env/deploys/deploy-lock",
  () => ({ DeployLockPanel: () => null, useDeployLock: () => ({}) })
);
vi.mock(
  "../web/routes/$locale/_app/-components/env/provisioning-panel",
  () => ({
    ProvisioningPanel: () => null,
  })
);

import { DeploysClient } from "../web/routes/$locale/_app/-components/env/deploys/deploys-client";

const SETTINGS = "/SCMB/demo-cloud/settings?tab=source";
const ADD = "/SCMB/demo-cloud/settings?tab=source&add=target";
const environment = { id: "e1", ownerId: null, services: [] } as never;

function page(role: "viewer" | "qa" | "engineer") {
  return renderToString(
    <QueryClientProvider client={new QueryClient()}>
      <IntlProvider locale="en" messages={messages}>
        <ProjectRoleProvider role={role}>
          <DeploysClient
            environment={environment}
            targets={[]}
            settingsHref={SETTINGS}
            addTargetHref={ADD}
          />
        </ProjectRoleProvider>
      </IntlProvider>
    </QueryClientProvider>
  );
}

const text = (html: string) =>
  html.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&");

describe("Deploys page without targets", () => {
  it("offers a configurer the way to add a target in Settings", () => {
    const html = page("engineer");
    expect(text(html)).toContain(messages.deploys.emptyTitle);
    expect(text(html)).toContain(messages.deploys.emptyDescription);
    expect(html.replace(/&amp;/g, "&")).toContain(`href="${ADD}"`);
    expect(text(html)).toContain(messages.deploys.addTarget);
  });

  it("shows a user without deploy:configure the text only", () => {
    const html = page("qa");
    expect(text(html)).toContain(messages.deploys.emptyDescriptionReadOnly);
    expect(html.replace(/&amp;/g, "&")).not.toContain(ADD);
    expect(text(html)).not.toContain(messages.deploys.addTarget);
  });
});
