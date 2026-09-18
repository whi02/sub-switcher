#!/usr/bin/env node
/**
 * Compliance gate.
 *
 * Claude Code's terms forbid third-party tools from touching credentials,
 * modifying the official binary, or intermediating API calls, and OpenAI's
 * terms forbid modifying its software or circumventing its limits. Those are
 * easy promises to make in a README and easy to break in a refactor, so this
 * script checks the actual code on every build.
 *
 * Rules run in one of two stages, because the two kinds of violation live in
 * different parts of the syntax:
 *
 *   "source" — comments removed, string literals intact. Catches module
 *              specifiers (`from "node:child_process"`) and literal paths.
 *   "code"   — comments removed and string bodies emptied, but template
 *              interpolations kept. Catches calls and identifiers without
 *              tripping over prose or over the `security find-generic-password`
 *              hint the doctor report *displays* to the user.
 *
 * A gate nobody has seen fail is worth nothing, so `verifyRules` runs known-bad
 * and known-good fixtures through the same code path on every invocation. If
 * the stripper or a pattern regresses, the audit fails before it ever looks at
 * src/.
 */

import { readFile, readdir } from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = path.join(root, "src");

/**
 * `stage` picks which stripped form the pattern is tested against.
 * Patterns are written without /g so `.test` stays stateless.
 */
const RULES = [
  {
    name: "credential access",
    stage: "code",
    why: "Sign-in must complete through Claude Code's or Codex's own flow; we never read or store tokens.",
    pattern:
      /\b(?:accessToken|refreshToken|idToken|access_token|refresh_token|id_token|claudeAiOauth|keytar|setPassword|getPassword|deletePassword|findCredentials)\b/,
  },
  {
    // CODEX_HOME itself is fine: it names a directory. What Codex keeps inside it is not ours.
    name: "Codex credential storage",
    stage: "source",
    why: "Codex sign-in lives inside CODEX_HOME; we never open, copy or inject it.",
    pattern: /auth\.json|codex_auth\.age|["']Codex Auth["']|CODEX_API_KEY|CODEX_ACCESS_TOKEN|OPENAI_API_KEY/,
  },
  {
    name: "process execution (import)",
    stage: "source",
    why: "Shelling out could invoke `security` or patch the official binary.",
    pattern: /["'](?:node:)?child_process["']/,
  },
  {
    // No receiver guard: `cp.spawn(...)` is the normal calling convention, so a
    // `(?<!\.)` here would exclude exactly the code we are looking for. Bare
    // `exec` is deliberately absent instead -- it is indistinguishable from
    // `RegExp.prototype.exec`, and the import rule above already blocks the only
    // module that could supply the dangerous one.
    name: "process execution (call)",
    stage: "code",
    why: "Shelling out could invoke `security` or patch the official binary.",
    pattern: /\b(?:execSync|execFileSync|spawnSync|execFile|spawn|fork)\s*\(/,
  },
  {
    name: "network access (import)",
    stage: "source",
    why: "We must not call Anthropic's or OpenAI's API on the user's behalf.",
    pattern: /["'](?:node:)?https?["']|["'](?:axios|node-fetch|undici|got|superagent)["']/,
  },
  {
    name: "network access (call)",
    stage: "code",
    why: "We must not call Anthropic's or OpenAI's API on the user's behalf.",
    pattern: /\bfetch\s*\(|\bXMLHttpRequest\b|\bhttps?\.(?:request|get)\s*\(|\baxios\b/,
  },
  {
    name: "writing into the official extension",
    stage: "source",
    why: "The official extensions and their bundled binaries must not be modified.",
    pattern: /vscode[/\\]extensions|anthropic\.claude-code|openai\.chatgpt/,
  },
];

/**
 * Remove comments, preserving every newline so reported line numbers stay
 * accurate. String and template literals are left untouched.
 */
export function stripComments(source) {
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
      while (i < n && !(source[i] === "*" && source[i + 1] === "/")) {
        // Keep the newlines a block comment spans, or every later line number shifts.
        if (source[i] === "\n") out += "\n";
        i += 1;
      }
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      const end = scanLiteral(source, i);
      out += source.slice(i, end);
      i = end;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

/**
 * Empty the text of string and template literals, keeping the quotes, the
 * newlines, and — crucially — the code inside `${...}` interpolations, which is
 * where a `${execSync("id")}` would otherwise hide.
 */
export function stripStringBodies(source) {
  let out = "";
  let i = 0;
  const n = source.length;

  while (i < n) {
    const c = source[i];
    if (c === '"' || c === "'") {
      const end = scanLiteral(source, i);
      out += c + newlinesIn(source.slice(i, end)) + c;
      i = end;
      continue;
    }
    if (c === "`") {
      out += stripTemplate(source, i);
      i = scanLiteral(source, i);
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

function newlinesIn(text) {
  return "\n".repeat((text.match(/\n/g) ?? []).length);
}

/** Index just past the literal beginning at `start`. Handles nested `${}`. */
function scanLiteral(source, start) {
  const quote = source[start];
  let i = start + 1;
  const n = source.length;

  while (i < n) {
    const c = source[i];
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === quote) {
      return i + 1;
    }
    if (quote === "`" && c === "$" && source[i + 1] === "{") {
      i = scanInterpolation(source, i + 1);
      continue;
    }
    i += 1;
  }
  return n;
}

/** Index just past the `{...}` beginning at `start`, tracking nested braces and literals. */
function scanInterpolation(source, start) {
  let depth = 0;
  let i = start;
  const n = source.length;

  while (i < n) {
    const c = source[i];
    if (c === '"' || c === "'" || c === "`") {
      i = scanLiteral(source, i);
      continue;
    }
    if (c === "{") depth += 1;
    if (c === "}") {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
    i += 1;
  }
  return n;
}

/** Rewrite one template literal: text becomes newlines, interpolations survive. */
function stripTemplate(source, start) {
  let out = "`";
  let i = start + 1;
  const n = source.length;

  while (i < n) {
    const c = source[i];
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === "`") {
      return `${out}\``;
    }
    if (c === "$" && source[i + 1] === "{") {
      const end = scanInterpolation(source, i + 1);
      out += `\${${stripStringBodies(source.slice(i + 2, end - 1))}}`;
      i = end;
      continue;
    }
    if (c === "\n") out += "\n";
    i += 1;
  }
  return `${out}\``;
}

function scan(source) {
  const stages = {
    source: stripComments(source),
    code: stripStringBodies(stripComments(source)),
  };
  const hits = [];
  for (const rule of RULES) {
    stages[rule.stage].split("\n").forEach((line, index) => {
      if (rule.pattern.test(line)) {
        hits.push({ rule, line: index + 1, text: line.trim() });
      }
    });
  }
  return hits;
}

/**
 * Prove the gate still works. Every BAD fixture must be caught by the named
 * rule at the named line; no GOOD fixture may be caught at all.
 */
const BAD = [
  {
    what: "child_process import behind a long block comment",
    rule: "process execution (import)",
    line: 8,
    code: `/**\n * one\n * two\n * three\n * four\n * five\n */\nimport * as cp from "node:child_process";\n`,
  },
  {
    what: "spawn call",
    rule: "process execution (call)",
    line: 1,
    code: `cp.spawn("security", ["find-generic-password"]);\n`,
  },
  {
    what: "https import",
    rule: "network access (import)",
    line: 1,
    code: `import * as https from "node:https";\n`,
  },
  {
    what: "https.request call",
    rule: "network access (call)",
    line: 1,
    code: `https.request("https://api.anthropic.com");\n`,
  },
  {
    what: "execSync hidden in a template interpolation",
    rule: "process execution (call)",
    line: 1,
    code: "const x = `${execSync(\"id\")}`;\n",
  },
  {
    what: "token field access",
    rule: "credential access",
    line: 1,
    code: `const t = creds.accessToken;\n`,
  },
  {
    what: "path into the official extension",
    rule: "writing into the official extension",
    line: 1,
    code: `const p = "~/.vscode/extensions/anthropic.claude-code";\n`,
  },
  {
    what: "bare fetch",
    rule: "network access (call)",
    line: 1,
    code: `await fetch(url);\n`,
  },
  {
    what: "path to the Codex sign-in file",
    rule: "Codex credential storage",
    line: 1,
    code: `const f = path.join(codexHome, "auth.json");\n`,
  },
  {
    what: "Codex token field access",
    rule: "credential access",
    line: 1,
    code: `const t = auth.tokens.refresh_token;\n`,
  },
  {
    what: "injecting an API key into the environment",
    rule: "Codex credential storage",
    line: 1,
    code: `process.env["OPENAI_API_KEY"] = key;\n`,
  },
  {
    what: "the Codex keyring service name",
    rule: "Codex credential storage",
    line: 1,
    code: `keyring.load("Codex Auth", account);\n`,
  },
  {
    what: "the Codex extension's id",
    rule: "writing into the official extension",
    line: 1,
    code: `const id = "openai.chatgpt";\n`,
  },
];

const GOOD = [
  {
    what: "prose mentioning forbidden APIs",
    code: `// we never call execSync or read accessToken, and never import child_process\n`,
  },
  {
    what: "block comment mentioning forbidden APIs",
    code: `/**\n * Never opens the keychain, never spawns a process.\n * No accessToken here.\n */\n`,
  },
  {
    what: "the doctor report's displayed hint",
    code: `const hint = \`security find-generic-password -s "\${service}"\`;\n`,
  },
  {
    what: "regex exec, which is not process execution",
    code: `const m = pattern.exec(line);\n`,
  },
  {
    what: "an object property named fetch-ish",
    code: `const age = snapshot.fetchedAt;\n`,
  },
  {
    what: "selecting CODEX_HOME, which names a directory rather than a credential",
    code: `process.env["CODEX_HOME"] = dir;\n`,
  },
  {
    what: "a comment explaining where Codex keeps auth.json",
    code: `// Codex keeps auth.json inside CODEX_HOME; we never open it\n`,
  },
];

function verifyRules() {
  const problems = [];

  for (const fixture of BAD) {
    const hits = scan(fixture.code);
    const match = hits.find((h) => h.rule.name === fixture.rule && h.line === fixture.line);
    if (!match) {
      problems.push(
        `missed: ${fixture.what} — expected "${fixture.rule}" at line ${fixture.line}, got ` +
          (hits.length === 0
            ? "nothing"
            : hits.map((h) => `"${h.rule.name}"@${h.line}`).join(", ")),
      );
    }
  }

  for (const fixture of GOOD) {
    const hits = scan(fixture.code);
    if (hits.length > 0) {
      problems.push(
        `false positive: ${fixture.what} — ${hits.map((h) => `"${h.rule.name}"@${h.line}`).join(", ")}`,
      );
    }
  }
  return problems;
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

const selfTestProblems = verifyRules();
if (selfTestProblems.length > 0) {
  console.error("compliance audit: the gate itself is broken\n");
  for (const p of selfTestProblems) console.error(`  ${p}`);
  console.error("\nFix the stripper or the rules before trusting this audit.");
  process.exit(1);
}

const files = await collectSources(srcDir);
const violations = [];

for (const file of files) {
  const source = await readFile(file, "utf8");
  for (const hit of scan(source)) {
    violations.push({
      file: path.relative(root, file),
      line: hit.line,
      rule: hit.rule.name,
      why: hit.rule.why,
      text: hit.text,
    });
  }
}

if (violations.length === 0) {
  console.log(
    `compliance audit: self-test ${BAD.length + GOOD.length} fixtures ok, ` +
      `${files.length} files, no violations`,
  );
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
