import { describe, expect, it } from "vitest";
import { shq } from "@/lib/sh";

describe("shq", () => {
  it("wraps a plain value in single quotes", () => {
    expect(shq("hello")).toBe("'hello'");
  });

  it("wraps the empty string in empty single quotes", () => {
    expect(shq("")).toBe("''");
  });

  it("escapes an embedded single quote using the '\\'' trick", () => {
    // it's -> 'it'\''s'
    expect(shq("it's")).toBe("'it'\\''s'");
  });

  it("escapes multiple single quotes", () => {
    expect(shq("a'b'c")).toBe("'a'\\''b'\\''c'");
  });

  it("leaves shell metacharacters literal inside the quotes", () => {
    const value = "$(rm -rf /); `whoami` && echo $HOME | cat > /tmp/x";
    expect(shq(value)).toBe(`'${value}'`);
  });

  it("does not treat backslashes specially", () => {
    expect(shq("a\\b")).toBe("'a\\b'");
  });

  it("round-trips: the result is a valid single safe shell token", () => {
    // A leading/trailing single quote in the value is still escaped.
    expect(shq("'")).toBe("''\\'''");
  });
});
