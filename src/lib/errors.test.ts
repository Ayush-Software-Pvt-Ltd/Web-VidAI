import { describe, expect, it } from "vitest";
import { ApiError, parseWireError, toApiError } from "./errors";

describe("the field of a refusal", () => {
  it("is carried from the wire body", () => {
    const error = parseWireError({
      code: "invalidInput",
      message: "Too short.",
      field: "password",
    });
    expect(error).toBeInstanceOf(ApiError);
    expect(error?.field).toBe("password");
  });

  it("is absent when the server named none, or sent something that is no text", () => {
    expect(parseWireError({ code: "conflict", message: "No." })?.field).toBeUndefined();
    expect(parseWireError({ code: "conflict", message: "No.", field: 7 })?.field).toBeUndefined();
    expect(new ApiError("conflict", "No.", "").field).toBeUndefined();
  });

  it("survives toApiError for a plain object and for an ApiError", () => {
    const plain = toApiError({ code: "invalidInput", message: "Bad.", field: "email" });
    expect(plain.field).toBe("email");
    expect(toApiError(plain)).toBe(plain);
    expect(toApiError(new Error("x")).field).toBeUndefined();
  });
});
