// crewglass-hook — the tiny helper Claude Code runs on every hook event (Live mode, plan §4.2).
//
//   "…/crewglass-hook" --socket "…/crewglass.sock"
//
// Rules: it forwards only whitelisted fields (never prompts, tool output or replies), waits at most 300 ms for
// Crewglass's answer, prints only what the answer requires, and ALWAYS exits 0. If Crewglass isn't running —
// or keeps answering slowly — it allows everything, so Claude is never blocked by Crewglass being absent.
// One exception (plan §6.6): a subagent calling another agent directly gets Claude Code's own permission prompt
// instead, so those calls are never silently allowed. And if Crewglass answers {"wait":true,"ms":…} (it's waiting for
// your approval, or running checks), the helper keeps waiting for the real answer, that long.

import Foundation

let args = CommandLine.arguments
var socketPath = ""
var i = 1
while i < args.count {
  if args[i] == "--socket", i + 1 < args.count { socketPath = args[i + 1]; i += 2 } else { i += 1 }
}

let input = FileHandle.standardInput.readDataToEndOfFile()
guard !socketPath.isEmpty, input.count < 64 << 20,
      let obj = (try? JSONSerialization.jsonObject(with: input)) as? [String: Any] else { exit(0) }

let event = obj["hook_event_name"] as? String ?? ""
let slowMarker = socketPath + ".slow"
let toolName = obj["tool_name"] as? String ?? ""
let isDirectCall = event == "PreToolUse" && (toolName == "Agent" || toolName == "Task") && !((obj["agent_id"] as? String) ?? "").isEmpty

/// Crewglass can't answer. Allow — except a subagent's direct call, which gets Claude Code's own prompt.
func giveUp() -> Never {
  if isDirectCall {
    let ask: [String: Any] = ["hookSpecificOutput": ["hookEventName": "PreToolUse", "permissionDecision": "ask",
      "permissionDecisionReason": "Crewglass isn't answering, so this direct call between agents needs your OK."]]
    if let data = try? JSONSerialization.data(withJSONObject: ask) { FileHandle.standardOutput.write(data) }
  }
  exit(0)
}

// If Crewglass answered slowly three times in a row, stop waiting for 60 s.
if let s = try? String(contentsOfFile: slowMarker, encoding: .utf8), let parts = Optional(s.split(separator: " ")),
   parts.count == 2, let count = Int(parts[0]), let until = Double(parts[1]), count >= 3, Date().timeIntervalSince1970 < until {
  giveUp()
}

func normalize(_ s: String, max: Int) -> String {
  let collapsed = s.split(whereSeparator: { $0 == " " || $0 == "\n" || $0 == "\t" || $0 == "\r" }).joined(separator: " ")
  return collapsed.count > max ? String(collapsed.prefix(max)) : collapsed
}

// ── whitelisted fields only ──
var msg: [String: Any] = ["event": event]
for key in ["session_id", "cwd", "transcript_path", "agent_id", "agent_type", "tool_name", "tool_use_id", "permission_mode", "notification_type", "source"] {
  if let v = obj[key] as? String { msg[key] = v }
}
if event == "SessionEnd", let r = obj["reason"] as? String { msg["end_reason"] = r }
if let b = obj["stop_hook_active"] as? Bool { msg["stop_hook_active"] = b }
if let bg = obj["background_tasks"] as? [Any] { msg["background_count"] = bg.count }
if event == "UserPromptSubmit", let p = obj["prompt"] as? String { msg["task_notification"] = p.hasPrefix("<task-notification>") }
if let ti = obj["tool_input"] as? [String: Any] {
  if let c = ti["command"] as? String { msg["command"] = normalize(c, max: 200) }
  if let f = ti["file_path"] as? String { msg["file_path"] = f }
  if let t = ti["subagent_type"] as? String { msg["subagent_type"] = t }
  if let s = ti["skill"] as? String { msg["skill"] = s }
  if let p = ti["prompt"] as? String, toolName == "Agent" || toolName == "Task" {
    if let first = p.split(separator: "\n", maxSplits: 1).first, first.hasPrefix("Reason:") {
      msg["call_reason"] = normalize(String(first.dropFirst(7)), max: 200)
    }
    // "Allowed calls: tester, reviewer — to run the tests": only the agent names are forwarded.
    if let line = p.split(separator: "\n").first(where: { $0.hasPrefix("Allowed calls:") }) {
      let names = line.dropFirst(14).split(whereSeparator: { "—–:(".contains($0) }).first.map(String.init) ?? ""
      let valid = names.split(whereSeparator: { $0 == "," || $0 == " " }).map(String.init)
        .filter { n in n.count <= 64 && n.first.map { $0.isLowercase || $0.isNumber } == true
          && n.allSatisfy { ($0.isASCII && ($0.isLowercase || $0.isNumber)) || $0 == "-" } }
      if !valid.isEmpty { msg["allowed_calls"] = Array(valid.prefix(20)) }
    }
  }
}
if let e = obj["error"] as? String { msg["error_kind"] = e.hasPrefix("Exit code") ? String(e.prefix(16)) : "error" }

guard let payload = try? JSONSerialization.data(withJSONObject: msg) else { exit(0) }

// ── talk to Crewglass over its Unix socket ──
let fd = socket(AF_UNIX, SOCK_STREAM, 0)
if fd < 0 { exit(0) }
var addr = sockaddr_un()
addr.sun_family = sa_family_t(AF_UNIX)
let fits = socketPath.withCString { p -> Bool in
  guard strlen(p) < MemoryLayout.size(ofValue: addr.sun_path) else { return false }
  _ = withUnsafeMutablePointer(to: &addr.sun_path) { $0.withMemoryRebound(to: CChar.self, capacity: 104) { strcpy($0, p) } }
  return true
}
if !fits { giveUp() }
let connected = withUnsafePointer(to: &addr) {
  $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
}
if connected != 0 { giveUp() } // Crewglass isn't running: allow everything (direct calls: Claude asks you)

var tv = timeval(tv_sec: 0, tv_usec: 300_000)
setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, socklen_t(MemoryLayout<timeval>.size))
setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &tv, socklen_t(MemoryLayout<timeval>.size))
var out = payload
out.append(0x0A)
_ = out.withUnsafeBytes { write(fd, $0.baseAddress, out.count) }

var reply = Data()
var buf = [UInt8](repeating: 0, count: 65536)
var timedOut = false
var waited = false
reading: while reply.count < 1 << 20 {
  let n = read(fd, &buf, buf.count)
  if n < 0 { timedOut = true; break }
  if n == 0 { break }
  reply.append(contentsOf: buf[0..<n])
  // A first line of {"wait":true} means Crewglass is waiting for your approval: keep reading, up to 140 s.
  while let nl = reply.firstIndex(of: 0x0A) {
    let line = reply[reply.startIndex..<nl]
    if !waited, let w = (try? JSONSerialization.jsonObject(with: line)) as? [String: Any], w["wait"] as? Bool == true {
      waited = true
      reply = Data(reply[reply.index(after: nl)...])
      // How long: an approval (~2 min) or checks (~5 min). Clamped to 1 s … 30 min.
      let ms = min(max((w["ms"] as? NSNumber)?.intValue ?? 140_000, 1_000), 1_800_000)
      var long = timeval(tv_sec: ms / 1000, tv_usec: Int32((ms % 1000) * 1000))
      setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &long, socklen_t(MemoryLayout<timeval>.size))
      continue
    }
    reply = Data(line)
    break reading
  }
}
close(fd)

// Slow-answer bookkeeping.
let previous = (try? String(contentsOfFile: slowMarker, encoding: .utf8))?.split(separator: " ").first.flatMap { Int($0) } ?? 0
if timedOut && !waited {
  let count = previous + 1
  try? "\(count) \(Date().timeIntervalSince1970 + 60)".write(toFile: slowMarker, atomically: true, encoding: .utf8)
  giveUp()
} else if timedOut {
  giveUp() // an approval that never got an answer
} else if previous > 0 {
  try? FileManager.default.removeItem(atPath: slowMarker)
}

// Print only what Crewglass asked for. SessionStart: only a one-line notice for you (`systemMessage` is shown in the
// chat, never read by Claude); anything that would reach Claude's context is dropped. A real user prompt: nothing.
guard let answer = (try? JSONSerialization.jsonObject(with: reply)) as? [String: Any] else { if waited { giveUp() }; exit(0) }
guard let toPrint = answer["print"] as? [String: Any] else { exit(0) }
if event == "SessionStart" {
  guard toPrint.count == 1, let note = toPrint["systemMessage"] as? String, !note.isEmpty, note.count <= 300 else { exit(0) }
}
if event == "UserPromptSubmit" && (msg["task_notification"] as? Bool) != true { exit(0) }
if let data = try? JSONSerialization.data(withJSONObject: toPrint) { FileHandle.standardOutput.write(data) }
exit(0)
