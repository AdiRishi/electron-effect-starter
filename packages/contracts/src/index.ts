// Schema-only shared contracts. No runtime logic lives here — this package is
// the typed boundary between the shell, the server, and the renderer.
export * from "./baseSchemas.ts";
export * from "./auth.ts";
export * from "./server.ts";
export * from "./notes.ts";
export * from "./desktop.ts";
export * from "./ipc.ts";
export * from "./rpc.ts";
