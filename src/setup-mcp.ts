// ── Checking an MCP server address ──────────────────────────────────────────
//
// An MCP address is not a credential, so it must not be checked like one. Past it to
// a provider's key endpoint and you get a 401 that means nothing at all. What an MCP
// address needs is the protocol's own handshake: send `initialize`, and a server that
// answers with a `serverInfo` block is real and speaks MCP.
//
// That distinction is the whole reason this file exists rather than reusing
// `validateProviderKey`. A reachability check would happily pass for a URL that hosts
// an unrelated HTTP 200 page, and the operator would conclude their MCP server is
// wired when nothing was ever speaking MCP.
//
// Called from the browser through `POST /api/v1/setup/check-mcp`, which is
// unauthenticated for the same reason the key check is: before anything is configured
// there is no bearer token to present, and this is the only moment it is useful.

export interface McpCheckResult {
  ok: boolean;
  /** Key-free, and names what actually happened. */
  detail: string;
  /** The server's own name and version, when it answered. */
  server?: string;
}

const MCP_BODY_LIMIT = 8_000;

export async function checkMcpAddress(
  http: typeof fetch,
  rawUrl: string
): Promise<McpCheckResult> {
  const trimmed = rawUrl.trim();
  if (trimmed === "") return { ok: false, detail: "Paste an address first." };

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { ok: false, detail: "That is not a URL." };
  }

  // Only http(s). A file: or data: URL is not an MCP server, and dialling it would be
  // asking the worker to do something its fetch binding is not for.
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return {
      ok: false,
      detail: "Only http and https addresses can be checked.",
    };
  }

  try {
    const response = await http(url.toString(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "simorgh-setup", version: "1" },
        },
      }),
    });

    if (!response.ok) {
      return {
        ok: false,
        detail:
          "The server answered " +
          response.status +
          " — reachable, but it refused an MCP handshake.",
      };
    }

    const text = (await response.text()).slice(0, MCP_BODY_LIMIT);
    const server = readServerInfo(text);
    if (server) {
      return {
        ok: true,
        detail: "It answered an MCP initialize handshake.",
        server,
      };
    }

    // A 200 with no parsable MCP payload is the interesting failure: it means the URL
    // is alive and is *not* an MCP server, which is exactly the case a reachability
    // check would have reported as success.
    return {
      ok: false,
      detail:
        "It answered 200 but not with an MCP handshake — the address is up, but nothing there speaks MCP.",
    };
  } catch {
    return {
      ok: false,
      detail: "Could not reach that address to run the handshake.",
    };
  }
}

/**
 * Pull `serverInfo.name`/`version` out of an MCP response.
 *
 * Accepts both the plain-JSON and the SSE (`data: {...}`) shapes, because a real MCP
 * server is allowed to answer either, and a checker that only understood one would
 * call a working server broken.
 */
function readServerInfo(text: string): string | undefined {
  const candidates = [text];
  for (const line of text.split("\n")) {
    const match = /^data:\s*(.+)$/.exec(line.trim());
    if (match) candidates.push(match[1]);
  }

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as {
        result?: { serverInfo?: { name?: string; version?: string } };
      };
      const info = parsed.result?.serverInfo;
      if (info && typeof info.name === "string" && info.name !== "") {
        return info.version ? info.name + " " + info.version : info.name;
      }
    } catch {
      // Not this candidate; try the next.
    }
  }
  return undefined;
}
