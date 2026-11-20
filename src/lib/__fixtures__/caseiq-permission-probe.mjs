import { readFile, writeFile } from "node:fs/promises";
import { joinSession } from "@github/copilot-sdk/extension";

const context = JSON.parse(await readFile(new URL("./context.json", import.meta.url), "utf8"));
const session = await joinSession();
if (session.sessionId !== context.sessionId) throw new Error("Synthetic probe joined another session.");
const configured = await session.rpc.mcp.listConfigured();
const names = configured.servers.map((server) => server.name);
const expected = context.expectedServers ?? ["SupportIQ"];
await writeFile(context.receipt, JSON.stringify({
  sameSession: true, names, isolated: JSON.stringify([...names].sort()) === JSON.stringify([...expected].sort()),
}), { mode: 0o600 });
