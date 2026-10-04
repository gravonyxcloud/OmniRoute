import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { workspaceTools } from "../../open-sse/mcp-server/tools/workspaceTools.ts";

type WorkspaceTool = {
  name: string;
  handler: (args: any) => Promise<any>;
};

function tool(name: string): WorkspaceTool {
  const found = (workspaceTools as readonly unknown[]).find(
    (entry) => (entry as { name?: string }).name === name
  ) as WorkspaceTool | undefined;
  assert.ok(found, `missing workspace tool: ${name}`);
  return found;
}

async function withWorkspace(
  callback: (root: string) => Promise<void>,
  options: { write?: boolean } = {}
) {
  const previousRoot = process.env.OMNIROUTE_MCP_WORKSPACE_ROOT;
  const previousWrite = process.env.OMNIROUTE_MCP_WORKSPACE_WRITE;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "omniroute-workspace-"));
  process.env.OMNIROUTE_MCP_WORKSPACE_ROOT = root;
  if (options.write) process.env.OMNIROUTE_MCP_WORKSPACE_WRITE = "true";
  else delete process.env.OMNIROUTE_MCP_WORKSPACE_WRITE;

  try {
    await callback(root);
  } finally {
    if (previousRoot === undefined) delete process.env.OMNIROUTE_MCP_WORKSPACE_ROOT;
    else process.env.OMNIROUTE_MCP_WORKSPACE_ROOT = previousRoot;
    if (previousWrite === undefined) delete process.env.OMNIROUTE_MCP_WORKSPACE_WRITE;
    else process.env.OMNIROUTE_MCP_WORKSPACE_WRITE = previousWrite;
    await fs.rm(root, { recursive: true, force: true });
  }
}

test("workspace MCP lists files for 'what files are here' requests", async () => {
  await withWorkspace(async (root) => {
    await fs.writeFile(path.join(root, "README.md"), "# demo\n");
    await fs.mkdir(path.join(root, "src"));
    await fs.writeFile(path.join(root, "src", "index.ts"), "export const ok = true;\n");

    const result = await tool("workspace_list").handler({
      relativePath: ".",
      recursive: true,
      limit: 100,
    });

    assert.deepEqual(
      result.entries.map((entry: { path: string }) => entry.path),
      ["README.md", "src", "src/index.ts"]
    );
  });
});

test("workspace MCP reads and searches text", async () => {
  await withWorkspace(async (root) => {
    await fs.writeFile(path.join(root, "notes.txt"), "alpha\nbeta target\ngamma\n");

    const read = await tool("workspace_read").handler({
      relativePath: "notes.txt",
      startLine: 2,
      endLine: 3,
    });
    assert.equal(read.content, "2: beta target\n3: gamma");

    const search = await tool("workspace_search").handler({
      query: "target",
      relativePath: ".",
      limit: 10,
    });
    assert.equal(search.matches.length, 1);
    assert.equal(search.matches[0].path, "notes.txt");
    assert.equal(search.matches[0].line, 2);
  });
});

test("workspace MCP blocks traversal and sensitive directories", async () => {
  await withWorkspace(async () => {
    await assert.rejects(
      () => tool("workspace_read").handler({ relativePath: "../secret.txt" }),
      /traversal|relative/i
    );
    await assert.rejects(
      () => tool("workspace_list").handler({ relativePath: ".ssh" }),
      /blocked/i
    );
  });
});

test("workspace writes are off by default and opt-in when explicitly enabled", async () => {
  await withWorkspace(async () => {
    await assert.rejects(
      () =>
        tool("workspace_write").handler({
          relativePath: "created.txt",
          content: "nope",
          overwrite: false,
        }),
      /writes are disabled/i
    );
  });

  await withWorkspace(
    async (root) => {
      const written = await tool("workspace_write").handler({
        relativePath: "created.txt",
        content: "hello",
        overwrite: false,
      });
      assert.equal(written.path, "created.txt");
      assert.equal(await fs.readFile(path.join(root, "created.txt"), "utf8"), "hello");

      const made = await tool("workspace_mkdir").handler({ relativePath: "nested/folder" });
      assert.equal(made.path, "nested/folder");
      assert.equal((await fs.stat(path.join(root, "nested", "folder"))).isDirectory(), true);
    },
    { write: true }
  );
});
