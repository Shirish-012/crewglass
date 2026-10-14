#!/usr/bin/env node
// Minimal stdio MCP server with one tool, "echo". Newline-delimited JSON-RPC.
import { createInterface } from "node:readline";

const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
const rl = createInterface({ input: process.stdin });

rl.on("line", (line) => {
  let req;
  try { req = JSON.parse(line); } catch { return; }
  if (req.id === undefined) return; // notification
  if (req.method === "initialize") {
    send({ jsonrpc: "2.0", id: req.id, result: {
      protocolVersion: req.params?.protocolVersion ?? "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: "echo", version: "0.0.1" },
    } });
  } else if (req.method === "tools/list") {
    send({ jsonrpc: "2.0", id: req.id, result: { tools: [{
      name: "echo",
      description: "Echo back the given text, prefixed with ECHO:",
      inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    }] } });
  } else if (req.method === "tools/call") {
    send({ jsonrpc: "2.0", id: req.id, result: { content: [{ type: "text", text: "ECHO:" + (req.params?.arguments?.text ?? "") }] } });
  } else {
    send({ jsonrpc: "2.0", id: req.id, error: { code: -32601, message: "Method not found" } });
  }
});
