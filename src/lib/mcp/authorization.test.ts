import { describe, expect, it } from "vitest";

import { ApiError } from "#/lib/api-error";
import { assertConnectionOwner } from "./core.server";

describe("MCP connection authorization", () => {
  it("allows the owning user", () => {
    const connection = { userId: "user_1" };
    expect(() => assertConnectionOwner(connection, "user_1")).not.toThrow();
  });

  it("uses a not-found response for another user's connection", () => {
    try {
      assertConnectionOwner({ userId: "user_1" }, "user_2");
      expect.unreachable("ownership assertion should fail");
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).status).toBe(404);
      expect((error as ApiError).details?.code).toBe("connection_not_found");
    }
  });

  it("uses the same response for a missing connection", () => {
    expect(() => assertConnectionOwner(undefined, "user_1")).toThrow("not found");
  });
});
