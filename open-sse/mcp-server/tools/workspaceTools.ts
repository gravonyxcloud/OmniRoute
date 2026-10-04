import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

const DEFAULT_MAX_READ_BYTES = 256 * 1024;
const DEFAULT_MAX_LIST_ENTRIES = 500;
const DEFAULT_MAX_SEARCH_RESULTS = 100;
const BLOCKED_SEGMENTS = new Set([
  ".git",
  ".ssh",
  ".env",
  ".omniroute",
  "node_modules",
  "secrets",
]);

function dataDir(): string {
  return process.env.DATA_DIR?.trim() || "/app/data";
}

export function getWorkspaceRoot(): string {
  return path.resolve(process.env.OMNIROUTE_MCP_WORKSPACE_ROOT?.trim() || path.join(dataDir(), "workspace"));
}

function writesEnabled(): boolean {
  return process.env.OMNIROUTE_MCP_WORKSPACE_WRITE === "true";
}

function assertSafeRelativePath(input: string): string {
  const trimmed = input.trim().replace(/\\/g, "/");
  if (!trimmed || trimmed === ".") return ".";
  if (path.isAbsolute(trimmed) || trimmed.startsWith("/") || /^[A-Za-z]:\//.test(trimmed)) {
    throw new Error("Workspace paths must be relative");
  }
  const normalized = path.posix.normalize(trimmed);
  if (normalized === ".." || normalized.startsWith("../")) {
    throw new Error("Workspace path traversal is not allowed");
  }
  const segments = normalized.split("/").filter(Boolean);
  if (segments.some((segment) => BLOCKED_SEGMENTS.has(segment.toLowerCase()))) {
    throw new Error("Workspace path is blocked");
  }
  return normalized || ".";
}

async function ensureWorkspaceRoot(): Promise<string> {
  const root = getWorkspaceRoot();
  await fs.mkdir(root, { recursive: true });
  return root;
}

async function resolveWorkspacePath(relativePath: string, options: { allowMissing?: boolean } = {}) {
  const root = await ensureWorkspaceRoot();
  const safeRelative = assertSafeRelativePath(relativePath);
  const candidate = path.resolve(root, safeRelative);
  const prefix = root.endsWith(path.sep) ? root : root + path.sep;
  if (candidate !== root && !candidate.startsWith(prefix)) {
    throw new Error("Workspace path escaped the configured root");
  }

  if (options.allowMissing) {
    const parent = path.dirname(candidate);
    const realParent = await fs.realpath(parent).catch(() => parent);
    if (realParent !== root && !realParent.startsWith(prefix)) {
      throw new Error("Workspace parent escaped the configured root");
    }
    return { root, candidate, relativePath: safeRelative };
  }

  const real = await fs.realpath(candidate);
  if (real !== root && !real.startsWith(prefix)) {
    throw new Error("Workspace symlink escaped the configured root");
  }
  return { root, candidate: real, relativePath: safeRelative };
}

function relativeName(root: string, absolute: string): string {
  const rel = path.relative(root, absolute).replace(/\\/g, "/");
  return rel || ".";
}

async function listWorkspace(args: { relativePath?: string; recursive?: boolean; limit?: number }) {
  const { root, candidate } = await resolveWorkspacePath(args.relativePath || ".");
  const stat = await fs.stat(candidate);
  if (!stat.isDirectory()) throw new Error("Workspace list target is not a directory");
  const limit = Math.min(args.limit ?? DEFAULT_MAX_LIST_ENTRIES, DEFAULT_MAX_LIST_ENTRIES);
  const recursive = args.recursive === true;
  const results: Array<{ path: string; type: "file" | "directory"; size?: number }> = [];
  const queue = [candidate];

  while (queue.length > 0 && results.length < limit) {
    const current = queue.shift()!;
    const entries = await fs.readdir(current, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (results.length >= limit) break;
      if (BLOCKED_SEGMENTS.has(entry.name.toLowerCase()) || entry.isSymbolicLink()) continue;
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) {
        results.push({ path: relativeName(root, absolute), type: "directory" });
        if (recursive) queue.push(absolute);
      } else if (entry.isFile()) {
        const fileStat = await fs.stat(absolute);
        results.push({ path: relativeName(root, absolute), type: "file", size: fileStat.size });
      }
    }
  }

  return { root: path.basename(root), path: relativeName(root, candidate), entries: results, truncated: results.length >= limit };
}

async function readWorkspace(args: { relativePath: string; startLine?: number; endLine?: number }) {
  const { root, candidate } = await resolveWorkspacePath(args.relativePath);
  const stat = await fs.stat(candidate);
  if (!stat.isFile()) throw new Error("Workspace read target is not a file");
  if (stat.size > DEFAULT_MAX_READ_BYTES) throw new Error("Workspace file exceeds the 256 KiB read limit");
  const raw = await fs.readFile(candidate);
  if (raw.includes(0)) throw new Error("Workspace read target is not a text file");
  const lines = raw.toString("utf8").split(/\r?\n/);
  const start = Math.max(1, args.startLine ?? 1);
  const end = Math.min(lines.length, args.endLine ?? Math.min(lines.length, start + 399));
  if (end < start) throw new Error("endLine must be greater than or equal to startLine");
  return {
    path: relativeName(root, candidate),
    startLine: start,
    endLine: end,
    totalLines: lines.length,
    content: lines.slice(start - 1, end).map((line, index) => `${start + index}: ${line}`).join("\n"),
  };
}

async function statWorkspace(args: { relativePath?: string }) {
  const { root, candidate } = await resolveWorkspacePath(args.relativePath || ".");
  const stat = await fs.stat(candidate);
  return {
    path: relativeName(root, candidate),
    type: stat.isDirectory() ? "directory" : stat.isFile() ? "file" : "other",
    size: stat.size,
    modifiedAt: stat.mtime.toISOString(),
    createdAt: stat.birthtime.toISOString(),
  };
}

async function searchWorkspace(args: { query: string; relativePath?: string; limit?: number }) {
  const query = args.query.trim().toLowerCase();
  if (!query) throw new Error("Search query is required");
  const { root, candidate } = await resolveWorkspacePath(args.relativePath || ".");
  const stat = await fs.stat(candidate);
  if (!stat.isDirectory()) throw new Error("Workspace search target is not a directory");
  const limit = Math.min(args.limit ?? 20, DEFAULT_MAX_SEARCH_RESULTS);
  const matches: Array<{ path: string; line: number; text: string }> = [];
  const queue = [candidate];

  while (queue.length > 0 && matches.length < limit) {
    const current = queue.shift()!;
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (matches.length >= limit) break;
      if (BLOCKED_SEGMENTS.has(entry.name.toLowerCase()) || entry.isSymbolicLink()) continue;
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) {
        queue.push(absolute);
        continue;
      }
      if (!entry.isFile()) continue;
      const fileStat = await fs.stat(absolute);
      if (fileStat.size > DEFAULT_MAX_READ_BYTES) continue;
      const raw = await fs.readFile(absolute);
      if (raw.includes(0)) continue;
      const lines = raw.toString("utf8").split(/\r?\n/);
      for (let index = 0; index < lines.length && matches.length < limit; index++) {
        if (lines[index].toLowerCase().includes(query)) {
          matches.push({ path: relativeName(root, absolute), line: index + 1, text: lines[index].slice(0, 500) });
        }
      }
    }
  }
  return { query: args.query, matches, truncated: matches.length >= limit };
}

async function writeWorkspace(args: { relativePath: string; content: string; overwrite?: boolean }) {
  if (!writesEnabled()) throw new Error("Workspace writes are disabled. Set OMNIROUTE_MCP_WORKSPACE_WRITE=true to enable them.");
  const { root, candidate } = await resolveWorkspacePath(args.relativePath, { allowMissing: true });
  await fs.mkdir(path.dirname(candidate), { recursive: true });
  if (!args.overwrite) {
    const exists = await fs.stat(candidate).then(() => true).catch(() => false);
    if (exists) throw new Error("Workspace file already exists; set overwrite=true to replace it");
  }
  const bytes = Buffer.byteLength(args.content, "utf8");
  if (bytes > DEFAULT_MAX_READ_BYTES) throw new Error("Workspace write exceeds the 256 KiB limit");
  await fs.writeFile(candidate, args.content, "utf8");
  return { path: relativeName(root, candidate), bytes, created: true };
}

async function mkdirWorkspace(args: { relativePath: string }) {
  if (!writesEnabled()) throw new Error("Workspace writes are disabled. Set OMNIROUTE_MCP_WORKSPACE_WRITE=true to enable them.");
  const { root, candidate } = await resolveWorkspacePath(args.relativePath, { allowMissing: true });
  await fs.mkdir(candidate, { recursive: true });
  return { path: relativeName(root, candidate), created: true };
}

export const workspaceTools = [
  {
    name: "workspace_status",
    description: "Show the OmniRoute MCP workspace status, configured root basename, and whether writes are enabled.",
    scopes: ["read:workspace"],
    inputSchema: z.object({}).strict(),
    handler: async () => {
      const root = await ensureWorkspaceRoot();
      return { configured: true, root: path.basename(root), writesEnabled: writesEnabled() };
    },
  },
  {
    name: "workspace_list",
    description: "List files and directories in the approved OmniRoute MCP workspace. Use this when the user asks what files are present.",
    scopes: ["read:workspace"],
    inputSchema: z.object({
      relativePath: z.string().trim().max(2048).default("."),
      recursive: z.boolean().default(false),
      limit: z.number().int().min(1).max(DEFAULT_MAX_LIST_ENTRIES).default(200),
    }).strict(),
    handler: listWorkspace,
  },
  {
    name: "workspace_read",
    description: "Read a bounded line range from a text file in the approved OmniRoute MCP workspace.",
    scopes: ["read:workspace"],
    inputSchema: z.object({
      relativePath: z.string().trim().min(1).max(2048),
      startLine: z.number().int().min(1).optional(),
      endLine: z.number().int().min(1).optional(),
    }).strict(),
    handler: readWorkspace,
  },
  {
    name: "workspace_search",
    description: "Search text recursively in the approved OmniRoute MCP workspace and return matching lines with relative paths.",
    scopes: ["read:workspace"],
    inputSchema: z.object({
      query: z.string().trim().min(1).max(500),
      relativePath: z.string().trim().max(2048).default("."),
      limit: z.number().int().min(1).max(DEFAULT_MAX_SEARCH_RESULTS).default(20),
    }).strict(),
    handler: searchWorkspace,
  },
  {
    name: "workspace_stat",
    description: "Get type, size, and timestamps for a file or directory in the approved OmniRoute MCP workspace.",
    scopes: ["read:workspace"],
    inputSchema: z.object({ relativePath: z.string().trim().max(2048).default(".") }).strict(),
    handler: statWorkspace,
  },
  {
    name: "workspace_write",
    description: "Create or overwrite a UTF-8 text file in the approved OmniRoute MCP workspace. Disabled unless OMNIROUTE_MCP_WORKSPACE_WRITE=true.",
    scopes: ["write:workspace"],
    inputSchema: z.object({
      relativePath: z.string().trim().min(1).max(2048),
      content: z.string().max(DEFAULT_MAX_READ_BYTES),
      overwrite: z.boolean().default(false),
    }).strict(),
    handler: writeWorkspace,
  },
  {
    name: "workspace_mkdir",
    description: "Create a directory inside the approved OmniRoute MCP workspace. Disabled unless OMNIROUTE_MCP_WORKSPACE_WRITE=true.",
    scopes: ["write:workspace"],
    inputSchema: z.object({ relativePath: z.string().trim().min(1).max(2048) }).strict(),
    handler: mkdirWorkspace,
  },
] as const;
