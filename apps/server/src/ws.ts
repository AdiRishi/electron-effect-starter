import { WS_METHODS, WS_PATH, WsRpcGroup } from "@app/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  HttpRouter,
  HttpServerRequest,
  HttpServerRespondable,
  HttpServerResponse,
} from "effect/http";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as RpcServer from "effect/rpc/RpcServer";

import { failAuthInvalid, failInternal } from "./auth/http.ts";
import * as ServerAuth from "./auth/ServerAuth.ts";
import * as SessionStore from "./auth/SessionStore.ts";
import * as NotesStore from "./notes/NotesStore.ts";
import * as ServerLifecycleEvents from "./ServerLifecycleEvents.ts";

// Transports stay thin: decode, call one service method, map errors.
export const layerHandlers = WsRpcGroup.toLayer(
  Effect.gen(function* () {
    const lifecycle = yield* ServerLifecycleEvents.ServerLifecycleEvents;
    const notes = yield* NotesStore.NotesStore;

    return WsRpcGroup.of({
      [WS_METHODS.serverProbe]: () => Effect.succeed({}),
      [WS_METHODS.subscribeServerLifecycle]: () => lifecycle.subscribe,
      [WS_METHODS.notesCreate]: (input) => notes.create(input),
      [WS_METHODS.notesUpdate]: (input) => notes.update(input),
      [WS_METHODS.notesDelete]: (input) => notes.remove(input.id).pipe(Effect.as({})),
      [WS_METHODS.subscribeNotes]: () => notes.subscribe,
    });
  }),
);

// Default socket-level Defect frames end every pending client request.
const RPC_SERVER_OPTIONS = {
  disableTracing: true,
  disableFatalDefects: true,
} as const;

export const layer = HttpRouter.add(
  "GET",
  WS_PATH,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const auth = yield* ServerAuth.ServerAuth;
    const sessions = yield* SessionStore.SessionStore;

    const session = yield* auth.authenticateWebSocketUpgrade(request).pipe(
      Effect.catchIf(ServerAuth.isServerAuthCredentialError, (error) =>
        failAuthInvalid(ServerAuth.serverAuthCredentialReason(error)),
      ),
      Effect.catchIf(ServerAuth.isServerAuthInternalError, (error) =>
        failInternal("internal_error", error),
      ),
    );

    const httpEffect = yield* Effect.gen(function* () {
      const { protocol, httpEffect } = yield* RpcServer.makeProtocolWithHttpEffectWebsocket;
      yield* RpcServer.make(WsRpcGroup, RPC_SERVER_OPTIONS).pipe(
        Effect.provideService(RpcServer.Protocol, protocol),
        Effect.forkScoped,
      );

      return httpEffect;
    }).pipe(Effect.provide(layerHandlers.pipe(Layer.provideMerge(RpcSerialization.layerJson))));

    // A socket must not outlive its session: revocation, replacement and expiry all close it, and
    // the client reconnects and reauthenticates.
    return yield* Effect.raceFirst(
      httpEffect,
      sessions.awaitInvalidation(session.sessionId).pipe(
        Effect.as(HttpServerResponse.empty()),
        Effect.catchTags({
          SessionCredentialVerificationError: (error) => failInternal("internal_error", error),
        }),
      ),
    );
  }).pipe(
    Effect.catchTags({
      AuthInvalidError: HttpServerRespondable.toResponse,
      InternalError: HttpServerRespondable.toResponse,
    }),
  ),
);
