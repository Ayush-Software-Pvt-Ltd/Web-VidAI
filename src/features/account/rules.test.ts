import { describe, expect, it } from "vitest";
import { changeFieldOf, setupFieldOf } from "./rules";

describe("which field a refusal belongs to", () => {
  it("follows the field the server named, whatever the sentence says", () => {
    expect(setupFieldOf({ message: "Something about the password", field: "email" })).toBe("email");
    expect(setupFieldOf({ message: "Enter a valid email address.", field: "password" })).toBe(
      "password",
    );
    expect(changeFieldOf({ message: "The current rules say no.", field: "newPassword" })).toBe(
      "new",
    );
    expect(changeFieldOf({ message: "A new password is needed.", field: "currentPassword" })).toBe(
      "current",
    );
  });

  it("falls back on the sentence when the refusal names no field", () => {
    expect(setupFieldOf({ message: "The password must have 8 to 200 characters." })).toBe(
      "password",
    );
    expect(setupFieldOf({ message: "Enter a valid email address." })).toBe("email");
    expect(changeFieldOf({ message: "The current password is wrong." })).toBe("current");
    expect(changeFieldOf({ message: "The password must have 8 to 200 characters." })).toBe("new");
  });

  it("falls back on the sentence for a field the form does not have", () => {
    expect(setupFieldOf({ message: "Enter a valid email address.", field: "token" })).toBe("email");
  });
});
