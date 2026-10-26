import { assert, describe, it } from "vitest";

import { verifyPreloadBundle } from "../../scripts/verify-preload-bundle.mjs";

const validPreload = `
  const electron = require("electron");
  const OPEN_EXTERNAL_CHANNEL = "desktop:open-external";
  electron.contextBridge.exposeInMainWorld("desktopBridge", {
    getClientPlatform: () => process.platform,
    getServerBootstrap: () => electron.ipcRenderer.sendSync("desktop:get-server-bootstrap"),
    getBearerToken: () => electron.ipcRenderer.invoke("desktop:get-bearer-token"),
    openExternal: (url) => electron.ipcRenderer.invoke(OPEN_EXTERNAL_CHANNEL, url),
  });
`;

describe("desktop preload bundle verifier", () => {
  it("rejects required API names that only appear in strings", () => {
    assert.throws(
      () =>
        verifyPreloadBundle(`
          "desktopBridge getClientPlatform getServerBootstrap getBearerToken openExternal";
          require("electron");
        `),
      /missing executable APIs/,
    );
  });

  it("rejects a required API whose exposed value is not callable", () => {
    assert.throws(
      () =>
        verifyPreloadBundle(
          validPreload.replace(
            "getClientPlatform: () => process.platform,",
            "getClientPlatform: undefined,",
          ),
        ),
      /missing executable APIs: getClientPlatform/,
    );
  });

  it("accepts a required API exposed through a function alias", () => {
    assert.doesNotThrow(() =>
      verifyPreloadBundle(`
        const readClientPlatform = () => process.platform;
        ${validPreload.replace(
          "getClientPlatform: () => process.platform,",
          "getClientPlatform: readClientPlatform,",
        )}
      `),
    );
  });

  it("rejects dynamic imports with comments before the opening parenthesis", () => {
    assert.throws(
      () =>
        verifyPreloadBundle(`${validPreload}\nimport /* @vite-ignore */("unsupported-module");`),
      /dynamic import\(\)/,
    );
  });

  it("rejects unsupported require calls with comments before the opening parenthesis", () => {
    assert.throws(
      () => verifyPreloadBundle(`${validPreload}\nrequire /* @__PURE__ */ ("node:fs");`),
      /unsupported sandbox imports: node:fs/,
    );
  });

  it("accepts Electron sandbox module aliases", () => {
    assert.doesNotThrow(() =>
      verifyPreloadBundle(`
        ${validPreload}
        require("electron/common");
        require("electron/renderer");
        require("node:events");
        require("node:timers");
        require("node:url");
      `),
    );
  });

  it("ignores require-like text in strings and comments", () => {
    assert.doesNotThrow(() =>
      verifyPreloadBundle(`
        ${validPreload}
        const message = 'require("node:fs")';
        // require("node:path")
      `),
    );
  });
});
