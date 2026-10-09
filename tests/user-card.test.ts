import { describe, expect, it } from "bun:test";
import { jiraProfileUrl } from "@/lib/people/card";

describe("jiraProfileUrl", () => {
  it("builds a cloud people url without a double slash", () => {
    expect(jiraProfileUrl("https://acme.atlassian.net/", "5f1c")).toBe(
      "https://acme.atlassian.net/jira/people/5f1c"
    );
  });
  it("encodes the account id", () => {
    expect(jiraProfileUrl("https://acme.atlassian.net", "a/b")).toBe(
      "https://acme.atlassian.net/jira/people/a%2Fb"
    );
  });
});
