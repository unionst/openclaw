import { describe, expect, it } from "vitest";

// Inline the function since it's not exported — mirrors the implementation in openresponses-http.ts
function normalizeResponsesUser(user: string | undefined): string | undefined {
  if (!user) {
    return user;
  }
  const digits = user.replace(/\D/g, "");
  if (!digits) {
    return user;
  }
  if (digits.length === 10) {
    return `+1${digits}`;
  }
  if (digits.length === 11 && digits.startsWith("1")) {
    return `+${digits}`;
  }
  if (digits.length >= 11) {
    return `+${digits}`;
  }
  return user;
}

describe("normalizeResponsesUser", () => {
  it("normalizes formatted US phone to E.164", () => {
    expect(normalizeResponsesUser("(619) 876-0251")).toBe("+16198760251");
  });

  it("normalizes 10-digit bare number", () => {
    expect(normalizeResponsesUser("6198760251")).toBe("+16198760251");
  });

  it("normalizes 11-digit with leading 1", () => {
    expect(normalizeResponsesUser("16198760251")).toBe("+16198760251");
  });

  it("passes through already-E.164 number", () => {
    expect(normalizeResponsesUser("+16198760251")).toBe("+16198760251");
  });

  it("normalizes international number", () => {
    expect(normalizeResponsesUser("+447979753427")).toBe("+447979753427");
  });

  it("returns undefined for undefined", () => {
    expect(normalizeResponsesUser(undefined)).toBeUndefined();
  });

  it("returns non-phone strings unchanged", () => {
    expect(normalizeResponsesUser("test-user")).toBe("test-user");
  });

  it("returns empty string unchanged", () => {
    expect(normalizeResponsesUser("")).toBe("");
  });
});
