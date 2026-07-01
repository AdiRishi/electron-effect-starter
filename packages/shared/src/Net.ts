import * as NodeNet from "node:net";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

/**
 * A tiny Effect wrapper over `node:net` so port-availability checks are
 * describable, testable effects rather than raw callbacks. Used by the shell's
 * backend-port scan and the dev-runner.
 */
export class NetService extends Context.Service<
  NetService,
  {
    readonly canListenOnHost: (port: number, host: string) => Effect.Effect<boolean>;
  }
>()("@app/shared/Net/NetService") {}

const canListenOnHost = (port: number, host: string): Effect.Effect<boolean> =>
  Effect.callback<boolean>((resume) => {
    const server = NodeNet.createServer();
    const cleanup = () => {
      server.removeAllListeners();
      server.close();
    };
    server.once("error", () => {
      server.removeAllListeners();
      server.close();
      resume(Effect.succeed(false));
    });
    server.once("listening", () => {
      cleanup();
      resume(Effect.succeed(true));
    });
    server.listen(port, host);
    return Effect.sync(cleanup);
  });

export const make = NetService.of({ canListenOnHost });

export const layer = Layer.succeed(NetService, make);
