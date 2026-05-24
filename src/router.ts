/**
 * Hashtag meta-agent routing.
 *
 * Parses #tag or #org/repo tokens from Telegram messages and routes them to
 * the appropriate cc-agent meta-agent instead of the local Claude session.
 *
 * Tag formats:
 *   #repo-name    → namespace=repo-name, repo=https://github.com/{DEFAULT_GITHUB_ORG}/repo-name
 *   #org/repo     → namespace=repo,      repo=https://github.com/org/repo
 */

import { execSync } from "child_process";
import { Redis } from "ioredis";

/** Callback type matching CcTgBot.callCcAgentTool */
export type CallToolFn = (toolName: string, args?: Record<string, unknown>) => Promise<string | null>;

export interface RoutingTag {
  namespace: string;
  repoUrl: string;
  /** Original message with the tag token stripped and whitespace collapsed */
  strippedMessage: string;
}

/**
 * Parse the first #tag or #org/repo token from a message.
 * Returns null when no routing tag is present.
 *
 * Examples:
 *   "#cc-agent fix the bug"           → { namespace: "cc-agent", repoUrl: "…/gonzih/cc-agent", … }
 *   "#gonzih/of-stack deploy it"      → { namespace: "of-stack", repoUrl: "…/gonzih/of-stack", … }
 *   "#org/repo do something"          → { namespace: "repo",     repoUrl: "…/org/repo", … }
 *   "please help #of-stack with this" → { namespace: "of-stack", repoUrl: "…/gonzih/of-stack", … }
 */
export function parseRoutingTag(text: string): RoutingTag | null {
  const defaultOrg = process.env.DEFAULT_GITHUB_ORG ?? "gonzih";

  // Match #word or #org/repo — each segment: starts with alphanumeric, allows ._- inside
  const match = text.match(/#([a-zA-Z0-9][a-zA-Z0-9._-]*)(?:\/([a-zA-Z0-9][a-zA-Z0-9._-]*))?/);
  if (!match) return null;

  const fullMatch = match[0]; // e.g. "#gonzih/of-stack"
  const part1 = match[1];    // org-or-repo
  const part2 = match[2];    // repo (only present in #org/repo format)

  let namespace: string;
  let repoUrl: string;

  if (part2) {
    // #org/repo format
    namespace = part2;
    repoUrl = `https://github.com/${part1}/${part2}`;
  } else {
    // #repo format — use DEFAULT_GITHUB_ORG
    namespace = part1;
    repoUrl = `https://github.com/${defaultOrg}/${part1}`;
  }

  // Strip the matched tag token and collapse whitespace
  const strippedMessage = text.replace(fullMatch, "").replace(/\s+/g, " ").trim();

  return { namespace, repoUrl, strippedMessage };
}

/**
 * Ensure a meta-agent for the given namespace is running.
 *
 * Steps:
 *   1. Check cca:meta-agent:status:{namespace} in Redis — return early if already running.
 *   2. Verify the GitHub repo exists; create it (public) if not.
 *   3. Call the start_meta_agent MCP tool via callTool.
 *   4. Poll the Redis status key every 1s until running or META_AGENT_TIMEOUT_MS expires.
 *
 * Throws on failure (repo creation error, tool call failure, or timeout).
 */
export async function ensureMetaAgent(
  namespace: string,
  repoUrl: string,
  callTool: CallToolFn,
  redis: Redis
): Promise<void> {
  const timeoutMs = parseInt(process.env.META_AGENT_TIMEOUT_MS ?? "10000", 10);
  const statusKey = `cca:meta-agent:status:${namespace}`;

  console.log(`[router] ensureMetaAgent namespace=${namespace} checking ${statusKey}`);

  // Fast path: already running or idle (idle = ready to receive messages)
  const statusRaw = await redis.get(statusKey);
  if (statusRaw) {
    try {
      const status = JSON.parse(statusRaw) as { status?: string };
      if (status.status === "running" || status.status === "idle") {
        console.log(`[router] meta-agent ${namespace} is already ready (status=${status.status})`);
        return;
      }
    } catch {
      // Corrupt status value — fall through and restart
    }
  }

  // Derive "org/repo" from the full URL for gh CLI calls
  const orgRepo = repoUrl.replace(/^https:\/\/github\.com\//, "");

  // Verify / create the GitHub repo
  try {
    execSync(`gh repo view ${orgRepo}`, { stdio: "ignore" });
  } catch {
    // Repo not found — create it
    try {
      execSync(
        `gh repo create ${orgRepo} --public --description "Meta-agent workspace for ${namespace}"`,
        { stdio: "pipe" }
      );
      console.log(`[router] created repo ${orgRepo} for namespace=${namespace}`);
    } catch (createErr) {
      throw new Error(`Failed to create repo ${orgRepo}: ${(createErr as Error).message}`);
    }
  }

  // Start the meta-agent via MCP
  const result = await callTool("start_meta_agent", { namespace, repo_url: repoUrl });
  if (result === null) {
    throw new Error(`start_meta_agent returned null — tool may not be available in cc-agent`);
  }

  // Poll until the meta-agent reports "running" or "idle" (both mean ready)
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 1000));
    const raw = await redis.get(statusKey);
    if (raw) {
      try {
        const s = JSON.parse(raw) as { status?: string };
        console.log(`[router] waiting for meta-agent ${namespace} — current status: ${s.status}`);
        if (s.status === "running" || s.status === "idle") return;
      } catch {
        // ignore parse errors, keep polling
      }
    } else {
      console.log(`[router] waiting for meta-agent ${namespace} — no status key yet`);
    }
  }

  throw new Error(`Meta-agent for ${namespace} did not become ready within ${timeoutMs}ms`);
}

/**
 * Route a message to a running meta-agent via Redis RPUSH.
 * The cc-agent polls cca:meta:{namespace}:input every 3s (up to 3s delivery latency).
 *
 * No-op when strippedMessage is empty (user sent only the tag token).
 */
export async function routeToMetaAgent(
  namespace: string,
  strippedMessage: string,
  redis: Redis
): Promise<void> {
  if (!strippedMessage) return;

  const entry = JSON.stringify({
    id: crypto.randomUUID(),
    content: strippedMessage,
    timestamp: new Date().toISOString(),
  });
  // FIFO — cc-agent reads via LPOP
  await redis.rpush(`cca:meta:${namespace}:input`, entry);
  console.log(`[router] routed message to meta-agent namespace=${namespace}`);
}
