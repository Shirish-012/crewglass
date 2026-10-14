import { describe, expect, it } from "vitest";
import { Alerts } from "../src/main/alerts";

const base = { folderName: "agent app", todayUsd: 0, limits: { session: 20, day: 50 } }; // US dollars

describe("alerts without hooks (Phase 1)", () => {
  it("pops up for a repeatedly failing command without putting the command in the notification", () => {
    const shown: string[] = [];
    const a = new Alerts();
    a.evaluate({ ...base, sessions: [], failStreaks: [{ session: "s1", owner: "coder", command: "curl -H 'Authorization: Bearer abc123SECRET'", count: 3 }] },
      (title, body) => shown.push(`${title}\n${body}`));
    expect(shown).toHaveLength(1);
    expect(shown[0]).not.toContain("SECRET");
    expect(shown[0]).not.toContain("curl");
    expect(a.items[0].data?.command).toContain("curl"); // the in-memory inbox keeps the detail
  });
  it("warns quietly at 80% and pops up at 100% of the session limit, once each", () => {
    const shown: string[] = [];
    const a = new Alerts();
    const run = (usd: number) => a.evaluate({ ...base, failStreaks: [], sessions: [{ id: "s1", name: "n", status: "busy", usd, contextPct: 10 }] }, (t) => shown.push(t));
    run(17); run(17);
    expect(a.items.filter((i) => i.kind === "limit")).toHaveLength(1);
    expect(shown).toHaveLength(0);
    run(21); run(21);
    expect(a.items.filter((i) => i.kind === "limit")).toHaveLength(2);
    expect(shown).toHaveLength(1);
  });
  it("adds a quiet context warning at 85% and re-arms after compaction", () => {
    const a = new Alerts();
    const run = (pct: number) => a.evaluate({ ...base, failStreaks: [], sessions: [{ id: "s1", name: "n", status: "busy", usd: 0, contextPct: pct }] }, () => {});
    run(86); run(90); run(40); run(88);
    expect(a.items.filter((i) => i.kind === "context")).toHaveLength(2);
    expect(a.items.every((i) => !i.popup)).toBe(true);
  });
});
