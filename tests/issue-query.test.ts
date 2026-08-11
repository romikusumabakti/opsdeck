import { describe, expect, it } from "vitest";
import { DEFAULT_PAGE_SIZE, parseIssueParams } from "@/lib/issue-query";

describe("parseIssueParams", () => {
  it("defaults to the newest-updated first page", () => {
    const p = parseIssueParams({});
    expect(p).toEqual({
      filters: {},
      sort: "updatedAt",
      desc: true,
      pageIndex: 0,
      pageSize: DEFAULT_PAGE_SIZE,
    });
  });

  it("keeps the filters the toolbar owns", () => {
    const p = parseIssueParams({
      q: "login",
      status: "open",
      project: "abc",
      label: "def",
      priority: "high",
      mine: "1",
      view: "board",
      group: "assignee",
    });
    expect(p.filters).toEqual({
      q: "login",
      status: "open",
      project: "abc",
      label: "def",
      priority: "high",
      mine: "1",
      view: "board",
      group: "assignee",
    });
  });

  it("ignores params it does not own", () => {
    const p = parseIssueParams({ redirect: "/evil", foo: "bar" });
    expect(p.filters).toEqual({});
  });

  it("reads the table's sort params", () => {
    expect(parseIssueParams({ iss_s: "priority", iss_d: "asc" })).toMatchObject(
      {
        sort: "priority",
        desc: false,
      }
    );
    expect(parseIssueParams({ iss_s: "title" })).toMatchObject({
      sort: "title",
      desc: true,
    });
  });

  it("falls back to the default sort for an unknown column", () => {
    // A hand-edited URL must not reach the SQL ORDER BY mapping.
    expect(parseIssueParams({ iss_s: "; drop table issues" }).sort).toBe(
      "updatedAt"
    );
  });

  it("clamps the page and page size", () => {
    expect(parseIssueParams({ iss_p: "-3" }).pageIndex).toBe(0);
    expect(parseIssueParams({ iss_p: "2.7" }).pageIndex).toBe(2);
    expect(parseIssueParams({ iss_p: "abc" }).pageIndex).toBe(0);
    expect(parseIssueParams({ iss_ps: "100000" }).pageSize).toBe(100);
    expect(parseIssueParams({ iss_ps: "0" }).pageSize).toBe(DEFAULT_PAGE_SIZE);
    expect(parseIssueParams({ iss_ps: "50" }).pageSize).toBe(50);
  });

  it("ignores repeated params rather than guessing", () => {
    expect(parseIssueParams({ status: ["open", "closed"] }).filters).toEqual(
      {}
    );
  });
});
