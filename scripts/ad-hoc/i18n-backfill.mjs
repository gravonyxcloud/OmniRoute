import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const MSG_DIR = join(ROOT, "src/i18n/messages");

const apiKeysNew = [
  "renewKey",
  "renewConfirm",
  "failedRenewKey",
  "renewedSuccess",
  "planLabel",
  "planLabelDesc",
  "planNone",
  "plan3d",
  "plan7d",
  "plan15d",
  "plan30d",
  "planTokenLimitHint",
  "planTokenLimitBadge",
  "plansEntryTitle",
  "plansEntryHint",
  "plansEntryCta",
  "customerEmail",
  "customerEmailPlaceholder",
  "renewalsBadge",
];
const sidebarNew = ["apiKeyPlanEndpoints", "apiKeyPlanEndpointsSubtitle"];

function getFork(file) {
  try {
    return JSON.parse(
      execSync(`git show 0f16936db:src/i18n/messages/${file}`, { cwd: ROOT, encoding: "utf8" })
    );
  } catch {
    return JSON.parse(
      execSync("git show 0f16936db:src/i18n/messages/en.json", { cwd: ROOT, encoding: "utf8" })
    );
  }
}

const START_KEY_RE = /^    "([^"]+)":/;

// Group the section body into entries {key, lines[]}. Each entry starts at a
// 4-space key line and includes every following line up to the next key line.
function groupEntries(body) {
  const entries = [];
  let cur = null;
  for (const ln of body) {
    const m = ln.match(START_KEY_RE);
    if (m) {
      if (cur) entries.push(cur);
      cur = { key: m[1], lines: [ln] };
    } else if (cur) {
      cur.lines.push(ln);
    }
  }
  if (cur) entries.push(cur);
  return entries;
}

function patchSectionLines(lines, section, addMap) {
  const header = `  "${section}": {`;
  const headerIdx = lines.findIndex((ln) => ln === header);
  if (headerIdx === -1) return null;

  let closeIdx = -1;
  for (let i = headerIdx + 1; i < lines.length; i++) {
    if (/^  \},?\r?$/.test(lines[i])) {
      closeIdx = i;
      break;
    }
  }
  if (closeIdx === -1) return null;

  const body = lines.slice(headerIdx + 1, closeIdx);
  const tail = lines.slice(closeIdx);
  const entries = groupEntries(body);
  const byKey = new Map(entries.map((e) => [e.key, e]));

  // Stable merge: walk existing entries in order, inserting pending new keys
  // (sorted) that sort before the current key; append the rest at the end.
  const pending = [...addMap.keys()].sort();
  const out = [];
  for (const e of entries) {
    while (pending.length && pending[0] < e.key) {
      const k = pending.shift();
      out.push({ key: k, lines: [`    ${addMap.get(k)}`] });
    }
    out.push(e);
  }
  for (const k of pending) {
    out.push({ key: k, lines: [`    ${addMap.get(k)}`] });
  }

  // Comma normalization: every entry but the last ends with a trailing comma
  // on its final physical line; the last entry must not.
  const rendered = out.map((e, i) => {
    const lst = e.lines.length - 1;
    const lastLine = e.lines[lst];
    const isLast = i === out.length - 1;
    if (isLast) {
      return [...e.lines.slice(0, lst), lastLine.replace(/,\s*\r?$/, "")];
    }
    const hasComma = /,\s*$/.test(lastLine);
    if (hasComma) return e.lines;
    const m = lastLine.match(/^([\s\S]*?)(\r?)$/);
    return [...e.lines.slice(0, lst), m[1] + "," + m[2]];
  });
  return [...lines.slice(0, headerIdx), header, ...rendered.flat(), ...tail];
}

const files = readdirSync(MSG_DIR).filter((f) => f.endsWith(".json"));
for (const file of files) {
  const fork = getFork(file);
  const raw = readFileSync(join(MSG_DIR, file), "utf8");

  const apiEntries = new Map();
  for (const k of apiKeysNew) {
    if (!raw.match(new RegExp(`^    "${k}":`, "m")) && fork.apiManager?.[k] !== undefined) {
      apiEntries.set(k, `"${k}": ${JSON.stringify(fork.apiManager[k])}`);
    }
  }
  const sbEntries = new Map();
  for (const k of sidebarNew) {
    if (!raw.match(new RegExp(`^    "${k}":`, "m")) && fork.sidebar?.[k] !== undefined) {
      sbEntries.set(k, `"${k}": ${JSON.stringify(fork.sidebar[k])}`);
    }
  }

  let lines = raw.split(/\r?\n/);
  if (lines[lines.length - 1] === "") lines.pop();

  if (apiEntries.size) {
    const r = patchSectionLines(lines, "apiManager", apiEntries);
    if (r) lines = r;
  }
  if (sbEntries.size) {
    const r = patchSectionLines(lines, "sidebar", sbEntries);
    if (r) lines = r;
  }

  const crlf = raw.includes("\r\n");
  const result = lines.join(crlf ? "\r\n" : "\n") + (crlf ? "\r\n" : "\n");
  if (result !== raw) {
    writeFileSync(join(MSG_DIR, file), result, "utf8");
    console.log(`updated ${file} (api+${apiEntries.size} sb+${sbEntries.size})`);
  } else {
    console.log(`unchanged ${file}`);
  }
}
