import { test, expect } from "bun:test";
import { T3Client } from "../src/t3-client.ts";

test("auth snapshots and Effect RPC use protocol 2 and stable command payloads", async () => {
  const requests: any[] = [];
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1",
    fetch(req, server) {
      const url = new URL(req.url);
      if (url.pathname === "/ws") {
        expect(url.searchParams.get('wsTicket')).toBe("test-ticket");
        expect(url.searchParams.get('orchestrationProtocol')).toBe("2");
        if (server.upgrade(req)) return;
      }
      expect(req.headers.get('authorization')).toBe("Bearer test-token");
      expect(req.headers.get('x-t3-orchestration-protocol')).toBe("2");
      if (url.pathname === "/api/auth/websocket-ticket") return Response.json({ ticket: "test-ticket" });
      if (url.pathname === "/api/orchestration/shell") return Response.json({ schemaVersion: 2, threads: [] });
      return new Response("secret response", { status: 401 });
    },
    websocket: { message(ws, data) {
      const request = JSON.parse(String(data)); requests.push(request);
      ws.send(JSON.stringify({ _tag: "Exit", requestId: request.id, exit: request.payload.type === "reject" ? { _tag: "Failure", cause: "secret-token" } : { _tag: "Success", value: { sequence: 42 } } }));
    } },
  });
  const client = new T3Client(`http://127.0.0.1:${server.port}`, "test-token");
  try {
    expect((await client.get('/api/orchestration/shell')).threads).toEqual([]);
    const command = { type: "message.dispatch", commandId: "durable-id" };
    expect(await client.dispatch(command)).toEqual({ sequence: 42 });
    expect(await client.dispatch(command)).toEqual({ sequence: 42 });
    expect(requests.map(r => r.payload)).toEqual([command, command]);
    expect(requests[0].tag).toBe("orchestration.dispatchCommand");
    await expect(client.dispatch({ type: "reject" })).rejects.toThrow("T3 rejected the orchestration command");
    await expect(client.get('/denied')).rejects.toThrow("HTTP 401");
  } finally { client.close(); server.stop(true); }
});

test("closed RPC connections reject pending commands", async () => {
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1",
    fetch(req, server) { if (new URL(req.url).pathname === '/ws') { if (server.upgrade(req)) return; } return Response.json({ ticket: "ticket" }); },
    websocket: { message(ws) { ws.close(); } },
  });
  const client = new T3Client(`http://127.0.0.1:${server.port}`, "token");
  try { await expect(client.dispatch({ type: "test" })).rejects.toThrow("closed"); }
  finally { client.close(); server.stop(true); }
});
