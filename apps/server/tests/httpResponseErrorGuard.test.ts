// @effect-diagnostics nodeBuiltinImport:off -- These guards wrap the raw Node HTTP server before Effect serves.
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";

import { afterEach, assert, describe, it } from "@effect/vitest";

import {
  guardHttpResponseWriteErrors,
  rejectRequestsUntilServing,
} from "../src/httpResponseErrorGuard.ts";

const servers: Array<NodeHttp.Server> = [];
const sockets: Array<NodeNet.Socket> = [];
const requests: Array<NodeHttp.ClientRequest> = [];

function listen(server: NodeHttp.Server): Promise<number> {
  servers.push(server);
  server.on("connection", (socket) => sockets.push(socket));

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();

      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Node returns a pipe name, AddressInfo or null.
      resolve(typeof address === "object" && address !== null ? address.port : 0);
    });
  });
}

function fetchResponse(
  port: number,
  path: string,
  upgrade = false,
): Promise<NodeHttp.IncomingMessage> {
  return new Promise((resolve, reject) => {
    const request = NodeHttp.get(
      {
        host: "127.0.0.1",
        port,
        path,
        agent: false,
        headers: upgrade
          ? {
              connection: "Upgrade",
              upgrade: "websocket",
              "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
              "sec-websocket-version": "13",
            }
          : {},
      },
      (response) => {
        response.on("error", reject);
        response.on("end", () => resolve(response));
        response.resume();
      },
    );

    requests.push(request);
    request.on("error", reject);
    request.on("upgrade", (response, socket) => {
      socket.destroy();
      resolve(response);
    });
  });
}

afterEach(async () => {
  for (const request of requests.splice(0)) request.destroy();

  for (const socket of sockets.splice(0)) socket.destroy();

  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

describe("guardHttpResponseWriteErrors", () => {
  // Without the guard, the socket's unhandled "error" event crashes the process and fails the run.
  it("contains an upgrade socket write failure instead of crashing the server", async () => {
    const server = guardHttpResponseWriteErrors(NodeHttp.createServer());
    const socketClosed = Promise.withResolvers<void>();

    server.on("upgrade", (_request, socket) => {
      socket.once("close", () => socketClosed.resolve());
      // Node's HTTP server no longer listens for errors on an upgraded socket.
      socket.destroy(Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
    });
    const port = await listen(server);

    const client = NodeNet.connect(port, "127.0.0.1", () => {
      client.write(
        [
          "GET /ws HTTP/1.1",
          "Host: 127.0.0.1",
          "Connection: Upgrade",
          "Upgrade: websocket",
          "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
          "Sec-WebSocket-Version: 13",
          "",
          "",
        ].join("\r\n"),
      );
    });

    sockets.push(client);
    client.on("error", () => undefined);
    await socketClosed.promise;

    server.on("request", (_request, response) => {
      response.writeHead(200, { "content-type": "text/plain" }).end("ok");
    });
    assert.strictEqual((await fetchResponse(port, "/")).statusCode, 200);
  });
});

describe("rejectRequestsUntilServing", () => {
  it("rejects early HTTP and upgrades, then hands each off to its serving handler", async () => {
    const server = rejectRequestsUntilServing(
      guardHttpResponseWriteErrors(NodeHttp.createServer()),
    );

    const port = await listen(server);

    const earlyHttp = await fetchResponse(port, "/");

    assert.strictEqual(earlyHttp.statusCode, 503);
    assert.strictEqual(earlyHttp.headers["retry-after"], "1");
    const earlyUpgrade = await fetchResponse(port, "/ws", true);

    assert.strictEqual(earlyUpgrade.statusCode, 503);
    assert.strictEqual(earlyUpgrade.headers["retry-after"], "1");

    server.on("request", (_request, response) => response.writeHead(204).end());
    const servingHttp = await fetchResponse(port, "/");

    assert.strictEqual(servingHttp.statusCode, 204);
    assert.isUndefined(servingHttp.headers["retry-after"]);
    // Upgrades stay rejected until an upgrade handler exists.
    const pendingUpgrade = await fetchResponse(port, "/ws", true);

    assert.strictEqual(pendingUpgrade.statusCode, 503);

    server.on("upgrade", (_request, socket) => {
      socket.end(
        "HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n",
      );
    });
    const servingUpgrade = await fetchResponse(port, "/ws", true);

    assert.strictEqual(servingUpgrade.statusCode, 101);
    assert.isUndefined(servingUpgrade.headers["retry-after"]);
  });
});
