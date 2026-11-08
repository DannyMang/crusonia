import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Env } from "../src/env.ts";
import { createMcpServer } from "../src/mcp/server.ts";
import {
  describeMinutes,
  sendApprovalTtlMinutes,
  toolApprovalTtlMinutes,
} from "../src/services/approval-ttl.ts";

describe("approval lifetimes", () => {
  test("defaults: send approvals 7 days, tool and question approvals 1 hour", () => {
    expect(sendApprovalTtlMinutes({})).toBe(7 * 24 * 60);
    expect(toolApprovalTtlMinutes({})).toBe(60);
  });

  test("SEND_APPROVAL_TTL_HOURS and TOOL_APPROVAL_TTL_MINUTES override them", () => {
    expect(sendApprovalTtlMinutes({ SEND_APPROVAL_TTL_HOURS: "48" })).toBe(48 * 60);
    expect(sendApprovalTtlMinutes({ SEND_APPROVAL_TTL_HOURS: "0.5" })).toBe(30);
    expect(toolApprovalTtlMinutes({ TOOL_APPROVAL_TTL_MINUTES: "15" })).toBe(15);
  });

  test("empty, zero, negative or non-numeric values fall back to the defaults", () => {
    for (const bad of ["", " ", "0", "-5", "abc", "Infinity"]) {
      expect(sendApprovalTtlMinutes({ SEND_APPROVAL_TTL_HOURS: bad })).toBe(10080);
      expect(toolApprovalTtlMinutes({ TOOL_APPROVAL_TTL_MINUTES: bad })).toBe(60);
    }
  });

  test("always at least one whole minute (Postgres make_interval takes integer minutes)", () => {
    expect(toolApprovalTtlMinutes({ TOOL_APPROVAL_TTL_MINUTES: "0.2" })).toBe(1);
    expect(toolApprovalTtlMinutes({ TOOL_APPROVAL_TTL_MINUTES: "2.6" })).toBe(3);
  });

  test("describeMinutes picks the largest whole unit", () => {
    expect(describeMinutes(10080)).toBe("7 days");
    expect(describeMinutes(1440)).toBe("1 day");
    expect(describeMinutes(2880 + 60)).toBe("49 hours");
    expect(describeMinutes(60)).toBe("1 hour");
    expect(describeMinutes(90)).toBe("90 minutes");
  });

  test("the MCP create_draft description states the configured send lifetime", async () => {
    const description = async (over: Partial<Env>) => {
      const client = new Client({ name: "test", version: "0" });
      const [a, b] = InMemoryTransport.createLinkedPair();
      await Promise.all([createMcpServer({ PUBLIC_URL: "https://example.test", ...over }).connect(a), client.connect(b)]);
      const { tools } = await client.listTools();
      await client.close();
      return tools.find((t) => t.name === "create_draft")!.description!;
    };
    expect(await description({})).toContain("expires in 7 days");
    expect(await description({ SEND_APPROVAL_TTL_HOURS: "36" })).toContain("expires in 36 hours");
  });
});
