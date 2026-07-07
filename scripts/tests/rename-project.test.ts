import { describe, expect, it } from "vitest";

import { isKebabCase, isReverseDns, toTitle } from "../rename-project.ts";

describe("toTitle", () => {
  it("title-cases a kebab name", () => {
    expect(toTitle("my-cool-app")).toBe("My Cool App");
  });

  it("handles a single word", () => {
    expect(toTitle("notes")).toBe("Notes");
  });

  it("keeps digits inside words", () => {
    expect(toTitle("app-2go")).toBe("App 2go");
  });
});

describe("isReverseDns", () => {
  it("accepts dot-separated lowercase segments", () => {
    expect(isReverseDns("com.mycompany")).toBe(true);
    expect(isReverseDns("io.github.arishi")).toBe(true);
  });

  it("rejects single segments, uppercase, and stray dots", () => {
    expect(isReverseDns("com")).toBe(false);
    expect(isReverseDns("Com.MyCompany")).toBe(false);
    expect(isReverseDns(".com.foo")).toBe(false);
    expect(isReverseDns("com.")).toBe(false);
    expect(isReverseDns("com..foo")).toBe(false);
    expect(isReverseDns("")).toBe(false);
  });
});

describe("isKebabCase", () => {
  it("accepts lowercase words joined by single hyphens", () => {
    expect(isKebabCase("my-cool-app")).toBe(true);
    expect(isKebabCase("notes")).toBe(true);
    expect(isKebabCase("app2")).toBe(true);
  });

  it("rejects uppercase, leading digits, and stray hyphens", () => {
    expect(isKebabCase("MyApp")).toBe(false);
    expect(isKebabCase("2fast")).toBe(false);
    expect(isKebabCase("-app")).toBe(false);
    expect(isKebabCase("app-")).toBe(false);
    expect(isKebabCase("a--b")).toBe(false);
    expect(isKebabCase("")).toBe(false);
  });
});
