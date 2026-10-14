// Fuzzing the hook socket (plan §9.2): random bytes, huge lines, wrong shapes and floods never reach the decision
// engine as a "message", and the server keeps answering real events afterwards.
import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { connect } from "node:net";
import { join } from "node:path";
import { startHookServer, validMessage } from "../src/main/live/hookServer";
import type { HookMsg } from "../src/main/live/liveEngine";
import { tempDir } from "./helpers";

function talk(sock: string, data: Buffer | string): Promise<string> {
  return new Promise((resolve) => {
    let out = "";
    const c = connect(sock);
    c.on("data", (d) => (out += d));
    c.on("error", () => resolve(out));
    c.on("close", () => resolve(out));
    c.setTimeout(3000, () => c.destroy());
    c.end(data);
  });
}

describe("hook socket under fuzzing", () => {
  it("rejects malformed input and keeps working", async () => {
    const sock = join(tempDir("fuzz-"), "d.sock");
    const got: HookMsg[] = [];
    const server = startHookServer(sock, (m) => { got.push(m); return {}; });
    await new Promise((r) => server.once("listening", r));
    const junk: (Buffer | string)[] = [
      ...Array.from({ length: 40 }, () => randomBytes(1 + Math.floor(Math.random() * 3000))),
      "\n", "null\n", "[]\n", "42\n", '"x"\n', "{}\n", '{"event":5}\n', `{"event":"${"x".repeat(100)}"}\n`,
      '{"event":"PreToolUse","command":{"$gt":1}}\n', '{"event":"PreToolUse","allowed_calls":"tester"}\n', '{"event":"PreToolUse","allowed_calls":[1,2]}\n',
      `{"event":"Stop","session_id":"${"s".repeat(5000)}"}\n`, "[".repeat(10000) + "\n", `{"event":"x","pad":"${"a".repeat(70 * 1024)}"}\n`,
    ];
    await Promise.all(junk.map((j) => talk(sock, j)));
    expect(got).toEqual([]); // nothing malformed was treated as an event
    const ok = await talk(sock, JSON.stringify({ event: "Stop", session_id: "s1", cwd: "/w" }) + "\n");
    expect(JSON.parse(ok)).toEqual({});
    expect(got).toHaveLength(1);
    server.close();
  });

  it("checks every field's type", () => {
    expect(validMessage({ event: "PreToolUse", session_id: "s", tool_name: "Bash", command: "ls" })).toBe(true);
    for (const bad of [{ event: "x", cwd: 5 }, { event: "x", background_count: "2" }, { event: "x", task_notification: "yes" }, { event: "x", allowed_calls: ["a".repeat(100)] }, { event: "x", allowed_calls: new Array(21).fill("a") }]) {
      expect(validMessage(bad)).toBe(false);
    }
  });
});
