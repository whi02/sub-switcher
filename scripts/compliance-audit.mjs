#!/usr/bin/env node
/**
 * Compliance gate.
 *
 * Claude Code's terms forbid third-party tools from touching credentials,
 * modifying the official binary, or intermediating API calls. Those are easy
 * promises to make in a README and easy to break in a refactor, so this script
 * checks the actual code on every build.
 *
 * Comments and string literals are stripped first: this file's own prose, and
 * the `security find-generic-password` hint the doctor report *displays*, must
 * not be mistaken for code that does the thing.
 */

import { readFile, readdir } from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = path.join(root, "src");

/** Each rule is a pattern that must not appear in executable code. */
const RULES = [
  {
    name: "credential access",
    why: "Sign-in must complete through Claude Code's own flow; we never read or store tokens.",
    pattern: /\b(?:accessToken|refreshToken|claudeAiOauth|find-generic-password|setPassword|getPassword|keytar)\b/,
  },
  {
    name: "process execution",
    why: "Shelling out could invoke `security` or patch the official binary.",
    pattern: /\b(?:child_process|execSync|execFileSync|spawnSync)\b/,
  },
  {
    name: "network access",
    why: "We must not call Anthropic's API on the user's behalf.",
    pattern: /\b(?:fetch|XMLHttpRequest|axios)\s*\(|\bnode:https?\b|require\(\s*["']https?["']\s*\)/,
  },
  {
    name: "writing into the official extension",
    why: "The Claude Code binary must not be modified.",
    pattern: /vscode[/\\]extensions|anthropic\.claude-code/,
  },
];

/**
 * Remove comments and string/template literal bodies so only executable tokens
 * remain. Deliberately simple: it over-strips regex literals in rare cases,
 * which can only cause a missed match in code we also review by hand.
 */
function stripCommentsAndStrings(source) {
  let out = "";
  let i = 0;
  const n = source.length;

  while (i < n) {
    const c = source[i];
    const next = source[i + 1];

    if (c === "/" && next === "/") {
      while (i < n && source[i] !== "\n") i += 1;
      continue;
    }
    if (c === "/" && next === "*") {
      i += 2;
      while (i < n && !(source[i] === "*" && source[i + 1] === "/")) i += 1;
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      i += 1;
      out += quote;
      while (i < n) {
        if (source[i] === "\\") {
          i += 2;
          continue;
        }
        if (source[i] === quote) {
          i += 1;
          break;
        }
        // Keep newlines so reported line numbers stay accurate.
        if (source[i] === "\n") out += "\n";
        i += 1;
      }
      out += quote;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

async function collectSources(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectSources(full)));
    } else if (entry.name.endsWith(".ts")) {
      files.push(full);
    }
  }
  return files;
}

const files = await collectSources(srcDir);
const violations = [];

for (const file of files) {
  const code = stripCommentsAndStrings(await readFile(file, "utf8"));
  code.split("\n").forEach((line, index) => {
    for (const rule of RULES) {
      if (rule.pattern.test(line)) {
        violations.push({
          file: path.relative(root, file),
          line: index + 1,
          rule: rule.name,
          why: rule.why,
          text: line.trim(),
        });
      }
    }
  });
}

if (violations.length === 0) {
  console.log(`compliance audit: ${files.length} files, no violations`);
  for (const rule of RULES) console.log(`  ok  ${rule.name}`);
  process.exit(0);
}

console.error(`compliance audit: ${violations.length} violation(s)\n`);
for (const v of violations) {
  console.error(`  ${v.file}:${v.line}  [${v.rule}]`);
  console.error(`    ${v.text}`);
  console.error(`    ${v.why}\n`);
}
process.exit(1);
