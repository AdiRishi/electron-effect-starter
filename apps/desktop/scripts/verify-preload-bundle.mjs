import * as NodeEvents from "node:events";
import * as NodeFSP from "node:fs/promises";
import * as NodeModule from "node:module";
import * as NodeTimers from "node:timers";
import * as NodeURL from "node:url";
import * as NodeVM from "node:vm";
import { parse } from "acorn";

/* oxlint-disable anti-slop/no-runtime-typeof -- Inspects an untyped syntax tree and the values the bundle exposes. */

// Runs the built preload the way a sandboxed renderer would: it may require only Electron's sandbox
// modules, and it must expose every bridge method as a function.
const expectedDesktopBridgeApis = [
  "getClientPlatform",
  "getServerBootstrap",
  "getBearerToken",
  "openExternal",
];

const preloadExecutionTimeoutMs = 1_000;
const electronVersion = NodeModule.createRequire(import.meta.url)("electron/package.json").version;

const isSyntaxNode = (value) =>
  typeof value === "object" && value !== null && "type" in value && typeof value.type === "string";

const inspectBundle = (source) => {
  const runtimeImports = [];

  const visit = (node) => {
    if (node.type === "ImportExpression") {
      throw new Error("Desktop preload bundle contains a dynamic import() call");
    }

    if (node.type === "CallExpression" && node.callee.type === "Identifier") {
      if (node.callee.name === "require") {
        const [argument] = node.arguments;

        if (node.arguments.length !== 1 || argument?.type !== "Literal") {
          throw new Error("Desktop preload bundle contains a dynamic require() call");
        }

        if (typeof argument.value !== "string") {
          throw new Error("Desktop preload bundle contains a dynamic require() call");
        }

        runtimeImports.push(argument.value);
      }
    }

    for (const child of Object.values(node)) {
      if (Array.isArray(child)) {
        for (const item of child) {
          if (isSyntaxNode(item)) visit(item);
        }
      } else if (isSyntaxNode(child)) {
        visit(child);
      }
    }
  };

  visit(parse(source, { ecmaVersion: "latest", sourceType: "script" }));

  return runtimeImports;
};

const createSandboxModules = (exposedGlobals) => {
  const ipcRenderer = {
    invoke: () => Promise.resolve(undefined),
    on: () => undefined,
    removeListener: () => undefined,
    sendSync: () => undefined,
  };

  const electron = {
    contextBridge: {
      exposeInMainWorld: (name, api) => exposedGlobals.set(name, api),
    },
    ipcRenderer,
    webUtils: {
      getPathForFile: () => "",
    },
  };

  return new Map([
    ["electron", electron],
    ["electron/common", electron],
    ["electron/renderer", electron],
    ["events", NodeEvents.default],
    ["node:events", NodeEvents.default],
    ["timers", NodeTimers.default],
    ["node:timers", NodeTimers.default],
    ["url", NodeURL.default],
    ["node:url", NodeURL.default],
  ]);
};

const executeBundle = (source, sandboxModules) => {
  const sandboxProcess = {
    contextIsolated: true,
    platform: process.platform,
    versions: { electron: electronVersion },
  };

  const requireSandboxModule = (moduleName) => {
    if (!sandboxModules.has(moduleName)) {
      throw new Error(
        `Unsupported sandbox module requested during preload execution: ${moduleName}`,
      );
    }

    return sandboxModules.get(moduleName);
  };

  NodeVM.runInNewContext(
    source,
    {
      process: sandboxProcess,
      require: requireSandboxModule,
    },
    {
      filename: "desktop-preload.cjs",
      timeout: preloadExecutionTimeoutMs,
    },
  );
};

export const verifyPreloadBundle = (source) => {
  const runtimeImports = inspectBundle(source);
  const exposedGlobals = new Map();
  const sandboxModules = createSandboxModules(exposedGlobals);

  const unsupportedImports = [...new Set(runtimeImports)]
    .filter((moduleName) => !sandboxModules.has(moduleName))
    .toSorted();

  if (unsupportedImports.length > 0) {
    throw new Error(
      `Desktop preload bundle contains unsupported sandbox imports: ${unsupportedImports.join(", ")}`,
    );
  }

  executeBundle(source, sandboxModules);

  const desktopBridge = exposedGlobals.get("desktopBridge");

  const missingApis = expectedDesktopBridgeApis.filter(
    (api) => typeof desktopBridge?.[api] !== "function",
  );

  if (!exposedGlobals.has("desktopBridge")) missingApis.unshift("desktopBridge exposure");

  if (missingApis.length > 0) {
    throw new Error(`Desktop preload bundle is missing executable APIs: ${missingApis.join(", ")}`);
  }
};

if (process.argv[1] && NodeURL.pathToFileURL(process.argv[1]).href === import.meta.url) {
  const preloadUrl = new URL("../dist-electron/preload.cjs", import.meta.url);
  const source = await NodeFSP.readFile(preloadUrl, "utf8");
  verifyPreloadBundle(source);
}
