import { describe, expect, it } from "vitest";
import { RESERVED_PREFIX_MESSAGE } from "@/lib/variables/errors";
import {
  generateValue,
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
    envSlug: "sucor-dev",
  };

  it("replaces {url} and {envSlug}, every occurrence", () => {
    expect(resolvePlaceholders("{url}/cb?e={envSlug}&again={url}", ctx)).toBe(
      "https://app.example.com/cb?e=sucor-dev&again=https://app.example.com"
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
});
