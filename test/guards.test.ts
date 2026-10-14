import { describe, expect, it } from "vitest";
import { findSecrets } from "@shared/secretGuard";
import { lineDiff } from "@shared/lineDiff";
import { detectFormatIssues, issuesSignature } from "../src/main/formatWatch";

const seen = (over: Partial<{ entryTypes: string[]; usageKeys: string[]; missingUsage: boolean }> = {}) => ({
  entryTypes: new Set(over.entryTypes ?? ["user", "assistant"]),
  usageKeys: new Set(over.usageKeys ?? ["input_tokens", "output_tokens"]),
  missingUsage: over.missingUsage ?? false,
  version: "2.1.290",
});

describe("unknown-fields check (D17)", () => {
  it("is silent for the shapes verified in Phase 0a", () => {
    expect(detectFormatIssues({ sessionFields: [["pid", "cwd", "sessionId", "status"]], kinds: ["interactive"], statuses: ["busy"], transcripts: seen() })).toEqual([]);
  });
  it("reports new fields and values as info, by name only", () => {
    const issues = detectFormatIssues({
      sessionFields: [["pid", "cwd", "sessionId", "newThing"]], kinds: ["remote"], statuses: ["busy"],
      transcripts: seen({ usageKeys: ["input_tokens", "reasoning_tokens"], entryTypes: ["assistant", "brand-new"] }),
    });
    expect(issues.map((i) => i.name).sort()).toEqual(["kind = \"remote\"", "message.usage.reasoning_tokens", "newThing", "type = \"brand-new\""]);
    expect(issues.every((i) => i.severity === "info")).toBe(true);
    expect(issues.find((i) => i.name.includes("reasoning"))?.fixFile).toBe("src/main/sources/transcripts.ts");
  });
  it("reports a missing field Crewglass relies on as a warning", () => {
    const issues = detectFormatIssues({ sessionFields: [["pid", "sessionId"]], kinds: [], statuses: [], transcripts: seen({ missingUsage: true }) });
    expect(issues.filter((i) => i.severity === "warn").map((i) => i.name).sort()).toEqual(["cwd", "message.usage"]);
  });
  it("has a stable signature for 'dismiss for this version'", () => {
    const a = detectFormatIssues({ sessionFields: [["pid", "cwd", "sessionId", "x"]], kinds: [], statuses: [], transcripts: seen() });
    expect(issuesSignature(a, "2.1.290")).toBe(issuesSignature([...a].reverse(), "2.1.290"));
    expect(issuesSignature(a, "2.1.290")).not.toBe(issuesSignature(a, "2.1.291"));
  });
});

describe("secret guard", () => {
  it("catches real key formats", () => {
    const text = ["token ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8", "key sk-ant-api03-abcdefghijklmnopqrstuvwxyz", "AKIAABCDEFGHIJKLMNOP", "password: hunter2hunter2hunter2"].join("\n");
    expect(findSecrets(text).map((h) => h.line)).toEqual([1, 2, 3, 4]);
  });
  it("masks what it shows", () => {
    expect(findSecrets("ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8")[0].preview).toBe("ghp_••••r8");
  });
  it("allows ${VAR} references and ordinary words", () => {
    expect(findSecrets('"GITHUB_TOKEN": "${GITHUB_TOKEN}"\nuse sk-learn for this\npassword: ${DB_PASSWORD}')).toEqual([]);
  });
});

describe("line diff", () => {
  it("marks added and removed lines", () => {
    expect(lineDiff("a\nb\nc", "a\nc\nd")).toEqual([
      { type: "same", text: "a" }, { type: "del", text: "b" }, { type: "same", text: "c" }, { type: "add", text: "d" },
    ]);
  });
});
