/**
 * Minimal `vscode` module for running the extension's logic outside the editor.
 *
 * The configuration store models the real scope semantics deliberately: `get()`
 * merges default ∪ global ∪ workspace, while `inspect()` keeps them separate.
 * Collapsing the two would hide the exact bug setEnvValue exists to avoid --
 * writing merged defaults back into the user's own settings.
 */
const defaults = new Map();
const globalScope = new Map();
const workspaceScope = new Map();

/** Queued answers for the interactive prompts, in call order. */
const prompts = { quickPick: [], inputBox: [], message: [] };
const shown = { info: [], warn: [], error: [] };
/** Every status bar item created, so a test can read what it displays. */
const statusBarItems = [];

function reset() {
  defaults.clear();
  globalScope.clear();
  workspaceScope.clear();
  prompts.quickPick.length = 0;
  prompts.inputBox.length = 0;
  prompts.message.length = 0;
  shown.info.length = 0;
  shown.warn.length = 0;
  shown.error.length = 0;
  statusBarItems.length = 0;
}

module.exports = {
  __defaults: defaults,
  __global: globalScope,
  __workspace: workspaceScope,
  __prompts: prompts,
  __shown: shown,
  __statusBarItems: statusBarItems,
  __reset: reset,

  workspace: {
    getConfiguration: (section) => ({
      get: (key, fallback) => {
        const k = `${section}.${key}`;
        if (workspaceScope.has(k)) return workspaceScope.get(k);
        if (globalScope.has(k)) return globalScope.get(k);
        if (defaults.has(k)) return defaults.get(k);
        return fallback;
      },
      inspect: (key) => {
        const k = `${section}.${key}`;
        return {
          key: k,
          defaultValue: defaults.get(k),
          globalValue: globalScope.get(k),
          workspaceValue: workspaceScope.get(k),
        };
      },
      update: async (key, value, target) => {
        const k = `${section}.${key}`;
        const store = target === 1 ? globalScope : workspaceScope;
        if (value === undefined) store.delete(k);
        else store.set(k, value);
      },
    }),
    onDidChangeConfiguration: () => ({ dispose() {} }),
  },

  window: {
    createStatusBarItem: () => {
      const item = { show() {}, hide() {}, dispose() {} };
      statusBarItems.push(item);
      return item;
    },
    showInformationMessage: async (msg) => {
      shown.info.push(msg);
      return prompts.message.shift();
    },
    showWarningMessage: async (msg) => {
      shown.warn.push(msg);
      return prompts.message.shift();
    },
    showErrorMessage: async (msg) => {
      shown.error.push(msg);
      return undefined;
    },
    showQuickPick: async () => prompts.quickPick.shift(),
    showInputBox: async () => prompts.inputBox.shift(),
    showTextDocument: async () => undefined,
  },

  commands: { registerCommand: () => ({ dispose() {} }), getCommands: async () => [] },
  StatusBarAlignment: { Left: 1, Right: 2 },
  ConfigurationTarget: { Global: 1, Workspace: 2 },
  QuickPickItemKind: { Separator: -1 },
  MarkdownString: class {
    constructor(value) {
      this.value = value;
    }
  },
  Disposable: class {
    constructor(fn) {
      this.dispose = fn;
    }
  },
};
