/**
 * Behavioural tests, run against a temporary HOME so they never touch the
 * machine's real Claude Code state.
 *
 * Every case here is a failure someone actually hit or a code review caught, so
 * each one names the behaviour it protects rather than the function it calls.
 *
 * HOME is redirected before anything imports the source modules, because
 * paths.ts resolves through os.homedir() at call time.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "account-lanes-test-"));
process.env["HOME"] = sandbox;

const vscode = (await import("vscode")) as unknown as {
  __defaults: Map<string, unknown>;
  __global: Map<string, unknown>;
  __workspace: Map<string, unknown>;
  __prompts: { quickPick: unknown[]; inputBox: unknown[]; message: unknown[] };
  __reset: () => void;
};

const { keychainServiceName } = await import("../src/doctor");
const { discoverCandidates, validateLabel, validateSlotDir, addAccountInteractive } = await import(
  "../src/setup"
);
const { loadProfiles, saveProfiles } = await import("../src/profiles");
const { readUtilization, peakUtilization } = await import("../src/usage");
const { applyAccountState, resolveConfigPathIn, commitAccountState, readConfig } = await import(
  "../src/claudeConfig"
);
const { setEnvValue, getConfiguredSlotDir } = await import("../src/envSettings");
const { switchTo, resetToDefaults, resolveActive } = await import("../src/switcher");
const { writeJsonAtomic } = await import("../src/fsAtomic");
const { profilesFile, stateDir, normalizeSlotDir, claudeConfigFile } = await import("../src/paths");

let failed = 0;
let passed = 0;

function describe(name: string) {
  console.log(`\n${name}`);
}

function it(name: string, condition: boolean, detail?: string) {
  if (condition) {
    passed += 1;
    console.log(`  ok    ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${name}${detail ? `  (${detail})` : ""}`);
  }
}

const ACCOUNT_A = { accountUuid: "uuid-a", emailAddress: "a@example.com" };
const ACCOUNT_B = { accountUuid: "uuid-b", emailAddress: "b@example.com" };

/** A config shaped like the real ~/.claude.json: account keys interleaved with unrelated ones. */
function seedConfig() {
  return {
    numStartups: 7,
    oauthAccount: { ...ACCOUNT_A },
    projects: { "/some/project": { history: [1, 2, 3] } },
    cachedUsageUtilization: {
      fetchedAtMs: 1_700_000_000_000,
      accountUuid: "uuid-a",
      utilization: {
        five_hour: { utilization: 12, resets_at: null },
        seven_day: { utilization: 40, resets_at: "2026-09-13T14:59:59Z" },
      },
    },
    machineID: "mid",
  };
}

async function freshSandbox() {
  vscode.__reset();
  await fs.rm(sandbox, { recursive: true, force: true });
  await fs.mkdir(sandbox, { recursive: true });
  await fs.mkdir(path.join(sandbox, ".claude"), { recursive: true });
  await writeJsonAtomic(claudeConfigFile(), seedConfig());
}

// ---------------------------------------------------------------------------

describe("keychain slot naming matches the CLI's own derivation");
{
  // Verified against the live keychain on the machine this was developed on:
  // ~/.claude-pro1 -> Claude Code-credentials-e8798890.
  it(
    "hashes an absolute path to the documented service name",
    keychainServiceName("/Users/whiyoung/.claude-pro1") === "Claude Code-credentials-e8798890",
    keychainServiceName("/Users/whiyoung/.claude-pro1"),
  );
  // os.homedir() is read here, not at module load, so it reflects the sandbox
  // HOME this suite redirects to.
  it(
    "resolves ~ to the same slot as the absolute form",
    keychainServiceName(path.join(os.homedir(), "x")) === keychainServiceName("~/x"),
  );
  it(
    "gives different directories different slots",
    keychainServiceName("/a") !== keychainServiceName("/b"),
  );
}

describe("slot discovery never offers a directory that holds no credentials");
{
  await freshSandbox();
  await fs.mkdir(path.join(sandbox, ".claude-pro1"), { recursive: true });
  await fs.mkdir(path.join(sandbox, ".claude-pro2"), { recursive: true });
  await fs.mkdir(stateDir(), { recursive: true });
  await writeJsonAtomic(path.join(sandbox, ".claude-pro2", ".claude.json"), {
    oauthAccount: ACCOUNT_B,
  });

  const found = (await discoverCandidates()).map((c) => c.dir);
  it("finds the real slots", found.length === 2, found.join(", "));
  it(
    "excludes the extension's own state directory",
    !found.includes(normalizeSlotDir(stateDir())),
  );
  it("excludes the shared data directory", !found.some((d) => d.endsWith("/.claude")));

  const pro2 = (await discoverCandidates()).find((c) => c.dir.endsWith("pro2"));
  it("reads the identity from a slot's own config", pro2?.oauthAccount?.accountUuid === "uuid-b");
}

describe("slot discovery honours the .config.json layout");
{
  const dir = path.join(sandbox, "layout");
  await fs.mkdir(dir, { recursive: true });
  const fallback = path.join(dir, ".claude.json");
  it("falls back to .claude.json", (await resolveConfigPathIn(dir, fallback)) === fallback);

  await fs.writeFile(path.join(dir, ".config.json"), "{}");
  it(
    "prefers .config.json when present",
    (await resolveConfigPathIn(dir, fallback)) === path.join(dir, ".config.json"),
  );
}

describe("account swap preserves everything it does not own");
{
  const config = seedConfig();
  const swapped = applyAccountState(config, {
    oauthAccount: ACCOUNT_B,
    caches: { cachedUsageUtilization: { accountUuid: "uuid-b", utilization: {} } },
  });

  it(
    "keeps the original key order",
    JSON.stringify(Object.keys(swapped)) === JSON.stringify(Object.keys(config)),
    Object.keys(swapped).join(","),
  );
  it("replaces the identity", (swapped["oauthAccount"] as typeof ACCOUNT_B).accountUuid === "uuid-b");
  it(
    "leaves unrelated state untouched",
    JSON.stringify(swapped["projects"]) === JSON.stringify(config["projects"]),
  );

  const back = applyAccountState(swapped, {
    oauthAccount: ACCOUNT_A,
    caches: { cachedUsageUtilization: config["cachedUsageUtilization"] },
  });
  it("round trips byte for byte", JSON.stringify(back) === JSON.stringify(config));

  const cleared = applyAccountState(config, {});
  it("drops the identity when a profile has no snapshot", !("oauthAccount" in cleared));
  it("drops account caches too", !("cachedUsageUtilization" in cleared));
  it("still keeps unrelated keys", "projects" in cleared && "machineID" in cleared);
}

describe("a corrupt profiles.json cannot break activation");
{
  await freshSandbox();
  await fs.mkdir(stateDir(), { recursive: true });
  await writeJsonAtomic(profilesFile(), {
    version: 1,
    activeId: "ghost",
    profiles: [
      null,
      { id: "no-dir" },
      { id: "ok", label: "ok", secureStorageDir: `${sandbox}/.claude-pro1` },
      { id: "ok", label: "duplicate", secureStorageDir: "/elsewhere" },
    ],
  });

  const state = await loadProfiles();
  it("drops entries that are not objects", state.profiles.length === 1, `${state.profiles.length}`);
  it("drops entries missing secureStorageDir", !state.profiles.some((p) => p.id === "no-dir"));
  it("drops duplicate ids", state.profiles.filter((p) => p.id === "ok").length === 1);
  it("ignores an activeId nothing matches", state.activeId === undefined);
  it("resolving the active profile does not throw", resolveActive(state).kind === "unconfigured");
}

describe("a profiles.json from a newer build is refused, not misread");
{
  await writeJsonAtomic(profilesFile(), { version: 99, profiles: [] });
  let message: string | undefined;
  try {
    await loadProfiles();
  } catch (err) {
    message = (err as Error).message;
  }
  it("throws rather than reinterpreting it as v1", message !== undefined);
  it("names the version it found", message?.includes("v99") === true, message);
}

describe("quota parsing survives corrupt timestamps");
{
  const snapshot = readUtilization({
    cachedUsageUtilization: {
      // Finite, so a naive Number.isFinite check passes, but out of Date's range.
      fetchedAtMs: 1e20,
      accountUuid: "uuid-a",
      utilization: { seven_day: { utilization: 5 } },
    },
  });
  it("does not throw RangeError", snapshot !== undefined);
  it("treats the unusable timestamp as absent", snapshot?.fetchedAt === undefined);
  it("keeps the numbers that are usable", snapshot?.sevenDay === 5);
  it("reports the peak window", peakUtilization(snapshot) === 5);

  it("returns nothing for an absent cache", readUtilization({}) === undefined);
}

describe("label and path input cannot escape the home directory");
{
  it("rejects a label with a path separator", validateLabel("../evil") !== undefined);
  it("rejects a label containing ..", validateLabel("a..b") !== undefined);
  it("rejects an empty label", validateLabel("   ") !== undefined);
  it("accepts an ordinary label", validateLabel("pro2") === undefined);

  it("rejects a relative directory", validateSlotDir("slots/pro2") !== undefined);
  it("rejects .. inside a directory", validateSlotDir("/a/../../etc") !== undefined);
  it("accepts an absolute directory", validateSlotDir("/a/b") === undefined);
  it("accepts a ~-relative directory", validateSlotDir("~/.claude-pro3") === undefined);
}

describe("adding a slot refuses directories that are not slots");
{
  await freshSandbox();
  vscode.__prompts.inputBox.push("state", stateDir());
  const result = await addAccountInteractive();
  it("declines the extension's own state directory", result === undefined);
}

describe("writing the environment setting respects configuration scopes");
{
  await freshSandbox();
  vscode.__defaults.set("claudeCode.environmentVariables", [
    { name: "UPSTREAM_DEFAULT", value: "1" },
  ]);

  await setEnvValue("CLAUDE_SECURESTORAGE_CONFIG_DIR", "/slot");
  const written = vscode.__global.get("claudeCode.environmentVariables") as { name: string }[];
  it(
    "does not copy contributed defaults into user settings",
    !written.some((e) => e.name === "UPSTREAM_DEFAULT"),
    written.map((e) => e.name).join(","),
  );
  it("still reads the merged value back", getConfiguredSlotDir() === "/slot");

  vscode.__global.set("claudeCode.environmentVariables", [
    { name: "CLAUDE_SECURESTORAGE_CONFIG_DIR", value: "/old", futureField: "keep" },
    { name: "MY_OWN", value: "x" },
  ]);
  await setEnvValue("CLAUDE_SECURESTORAGE_CONFIG_DIR", "/new");
  const after = vscode.__global.get("claudeCode.environmentVariables") as Record<string, unknown>[];
  const slot = after.find((e) => e["name"] === "CLAUDE_SECURESTORAGE_CONFIG_DIR");
  it("preserves the user's other entries", after.some((e) => e["name"] === "MY_OWN"));
  it("preserves fields it does not know about", slot?.["futureField"] === "keep");
  it("updates the value", slot?.["value"] === "/new");
}

describe("switching swaps the identity and the slot together");
{
  await freshSandbox();
  await fs.mkdir(stateDir(), { recursive: true });
  const slotA = path.join(sandbox, ".claude-a");
  const slotB = path.join(sandbox, ".claude-b");
  await fs.mkdir(slotA, { recursive: true });
  await fs.mkdir(slotB, { recursive: true });
  await saveProfiles({
    version: 1,
    profiles: [
      { id: "a", label: "a", secureStorageDir: slotA, oauthAccount: ACCOUNT_A },
      { id: "b", label: "b", secureStorageDir: slotB, oauthAccount: ACCOUNT_B },
    ],
  });

  await switchTo("b");
  const afterSwitch = (await readConfig()).config;
  it(
    "puts the target identity in the shared config",
    (afterSwitch["oauthAccount"] as typeof ACCOUNT_B).accountUuid === "uuid-b",
  );
  it("points the env setting at the target slot", getConfiguredSlotDir() === normalizeSlotDir(slotB));
  it("records the active profile", (await loadProfiles()).activeId === "b");
  it(
    "leaves unrelated config alone",
    JSON.stringify(afterSwitch["projects"]) === JSON.stringify(seedConfig()["projects"]),
  );

  await resetToDefaults();
  const afterReset = (await readConfig()).config;
  it("reset clears the env setting", getConfiguredSlotDir() === undefined);
  it(
    "reset restores the identity the config had before any switch",
    (afterReset["oauthAccount"] as typeof ACCOUNT_A).accountUuid === "uuid-a",
    JSON.stringify(afterReset["oauthAccount"]),
  );
}

describe("a swap that cannot be verified restores rather than half-applying");
{
  await freshSandbox();
  await fs.mkdir(stateDir(), { recursive: true });
  const before = JSON.stringify((await readConfig()).config);

  // attempts = 0 drives the path taken when every attempt loses the race with a
  // Claude process rewriting the file: give up, put the original back, report.
  let threw = false;
  try {
    await commitAccountState({ oauthAccount: ACCOUNT_B }, 0);
  } catch {
    threw = true;
  }
  it("reports the failure to the caller", threw);
  it(
    "leaves the config as it found it",
    JSON.stringify((await readConfig()).config) === before,
  );
  it("still has the identity it started with", before.includes("uuid-a"));
}

// ---------------------------------------------------------------------------

await fs.rm(sandbox, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
