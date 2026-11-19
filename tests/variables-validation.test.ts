import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { tagVariableSchema } from "@/lib/deploy/validation";
import {
  RESERVED_PREFIX_MESSAGE,
  TAG_VARIABLE_RESERVED_PREFIX_MESSAGE,
} from "@/lib/variables/errors";
import {
  generateValue,
  hasReservedPrefix,
  isReservedVariableName,
  resolvePlaceholders,
  variableNameSchema,
  variableValueSchema,
} from "@/lib/variables/validation";

describe("variableNameSchema", () => {
  it("accepts upper-case names with digits and underscores", () => {
    for (const name of [
      "A",
      "_X",
      "DATABASE_URL",
      "S3_BUCKET_2",
      "A".repeat(128),
    ]) {
      expect(variableNameSchema().safeParse(name).success).toBe(true);
    }
  });

  it("rejects other names", () => {
    for (const name of [
      "",
      "1A",
      "lower",
      "Mixed",
      "WITH-DASH",
      "WITH SPACE",
      "A.B",
      "A".repeat(129),
    ]) {
      expect(variableNameSchema().safeParse(name).success).toBe(false);
    }
  });

  it("says in the reserved-prefix message that the Panel writes DOCKER_REGISTRY", () => {
    expect(RESERVED_PREFIX_MESSAGE).toContain("DOCKER_REGISTRY");
  });

  // Compose and the Docker CLI read these from the project's .env: a
  // COMPOSE_PROJECT_NAME or COMPOSE_FILE would retarget another stack.
  it("rejects the COMPOSE_, DOCKER_ and BUILDKIT_ prefixes", () => {
    for (const name of [
      "COMPOSE_PROJECT_NAME",
      "COMPOSE_FILE",
      "COMPOSE_",
      "DOCKER_HOST",
      "DOCKER_DEFAULT_PLATFORM",
      "BUILDKIT_PROGRESS",
    ]) {
      const result = variableNameSchema().safeParse(name);
      expect(result.success, name).toBe(false);
      expect(result.error?.issues[0]?.message, name).toBe(
        RESERVED_PREFIX_MESSAGE
      );
    }
    for (const name of [
      "COMPOSE",
      "DOCKER",
      "MY_COMPOSE_FILE",
      "XDOCKER_HOST",
    ]) {
      expect(variableNameSchema().safeParse(name).success, name).toBe(true);
    }
  });

  it("allows COMPOSE_PROFILES as a stored variable but not as a tag variable", () => {
    expect(variableNameSchema().safeParse("COMPOSE_PROFILES").success).toBe(
      true
    );
    expect(isReservedVariableName("COMPOSE_PROFILES")).toBe(false);
    for (const name of ["COMPOSE_FILE", "COMPOSE_PROFILES_X", "DOCKER_HOST"]) {
      expect(isReservedVariableName(name), name).toBe(true);
    }
    expect(hasReservedPrefix("COMPOSE_PROFILES")).toBe(true);
    const tag = tagVariableSchema.safeParse("COMPOSE_PROFILES");
    expect(tag.success).toBe(false);
    // Tag names have no exemption, so their refusal must not promise one.
    expect(tag.error?.issues[0]?.message).toBe(
      TAG_VARIABLE_RESERVED_PREFIX_MESSAGE
    );
    expect(TAG_VARIABLE_RESERVED_PREFIX_MESSAGE).not.toContain(
      "COMPOSE_PROFILES"
    );
  });

  it("rejects the environment's tag variable names", () => {
    const schema = variableNameSchema(["IMAGE_TAG", "WEB_TAG"]);
    expect(schema.safeParse("IMAGE_TAG").success).toBe(false);
    expect(schema.safeParse("WEB_TAG").success).toBe(false);
    expect(schema.safeParse("OTHER_TAG").success).toBe(true);
  });
});

describe("variableValueSchema", () => {
  it("accepts any single-line text up to 8192 characters", () => {
    for (const value of [
      "",
      "a#b $HOME 'x' \"y\" \\z",
      "ü",
      "\t",
      "x".repeat(8192),
    ]) {
      expect(variableValueSchema.safeParse(value).success).toBe(true);
    }
  });

  it("rejects newline, carriage return, NUL and over-long values", () => {
    for (const value of ["a\nb", "a\rb", "a\0b", "\n", "x".repeat(8193)]) {
      expect(variableValueSchema.safeParse(value).success).toBe(false);
    }
  });
});

describe("resolvePlaceholders", () => {
  const ctx = {
    url: "https://app.example.com",
    envSlug: "kestrel-dev",
  };

  it("replaces {url} and {envSlug}, every occurrence", () => {
    expect(resolvePlaceholders("{url}/cb?e={envSlug}&again={url}", ctx)).toBe(
      "https://app.example.com/cb?e=kestrel-dev&again=https://app.example.com"
    );
  });

  it("leaves unknown placeholders and plain braces alone", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: .env text
    const value = "{other} ${VAR} {} {HOST} {host} {";
    expect(resolvePlaceholders(value, ctx)).toBe(value);
  });

  it("fails when a used placeholder has no value", () => {
    expect(() => resolvePlaceholders("x={url}", { ...ctx, url: null })).toThrow(
      "Placeholder {url} has no value for this environment"
    );
    // An unused null placeholder is fine.
    expect(resolvePlaceholders("{envSlug}", { url: null, envSlug: "e" })).toBe(
      "e"
    );
  });

  it("does not resolve placeholders inside substituted values", () => {
    expect(resolvePlaceholders("{url}", { ...ctx, url: "{envSlug}" })).toBe(
      "{envSlug}"
    );
  });
});

describe("generateValue", () => {
  it("returns exactly the requested number of URL-safe characters", () => {
    for (const length of [1, 2, 3, 4, 31, 32, 33, 64, 100]) {
      const value = generateValue(length);
      expect(value).toHaveLength(length);
      expect(value).toMatch(/^[A-Za-z0-9_-]+$/);
    }
    expect(generateValue(32).length).toBe(32);
  });

  it("differs between calls", () => {
    expect(generateValue(32)).not.toBe(generateValue(32));
  });

  it("rejects a non-positive or fractional length", () => {
    expect(() => generateValue(0)).toThrow();
    expect(() => generateValue(-1)).toThrow();
    expect(() => generateValue(1.5)).toThrow();
    expect(() => generateValue(8193)).toThrow();
  });

  // The variable and deploy-target forms import this module in the browser,
  // where Vite stubs Node built-ins and the import throws on load.
  it("imports no Node built-in", () => {
    const source = readFileSync("lib/variables/validation.ts", "utf8");
    expect(source).not.toMatch(/from "node:/);
  });

  it("does not use the Node-only Buffer global", () => {
    const source = readFileSync("lib/variables/validation.ts", "utf8");
    expect(source).not.toMatch(/\bBuffer\b/);
  });

  it("keeps the base64url alphabet and length for the maximum length", () => {
    const value = generateValue(8192);
    expect(value).toHaveLength(8192);
    expect(value).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});
