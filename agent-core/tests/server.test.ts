import { describe, expect, it } from "vitest";
import { VERSION, createServer } from "../src/server";

describe("agent-core stub server", () => {
  it("answers GET /health with 200 and the health payload", async () => {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (address === null || typeof address === "string") {
        throw new Error("expected the server to report a TCP address");
      }
      const response = await fetch(`http://127.0.0.1:${address.port}/health`);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ status: "ok", app: "acute-code" });
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it("exports a sidecar VERSION", () => {
    expect(VERSION).toBe("0.1.0");
  });
});
