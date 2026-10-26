import { NotesStreamEvent, WS_METHODS } from "@app/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Socket from "effect/socket/Socket";

import { ConnectionTransientError } from "../../src/connection/model.ts";
import * as RpcSession from "../../src/rpc/session.ts";

type SocketEventType = "open" | "message" | "close" | "error";

type SocketEvent = {
  readonly code?: number;
  readonly data?: string;
  readonly reason?: string;
  readonly type: SocketEventType;
};

type SocketListener = (event: SocketEvent) => void;

class TestWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readyState = TestWebSocket.CONNECTING;
  readonly sent: string[] = [];
  readonly url: string;
  readonly sentChanges: Queue.Queue<void>;
  private readonly listeners = new Map<SocketEventType, Set<SocketListener>>();

  constructor(url: string, sentChanges: Queue.Queue<void>) {
    this.url = url;
    this.sentChanges = sentChanges;
  }

  addEventListener(type: SocketEventType, listener: SocketListener) {
    const listeners = this.listeners.get(type) ?? new Set<SocketListener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: SocketEventType, listener: SocketListener) {
    this.listeners.get(type)?.delete(listener);
  }

  send(data: string) {
    this.sent.push(data);
    Queue.offerUnsafe(this.sentChanges, undefined);
  }

  close(code = 1000, reason = "") {
    if (this.readyState === TestWebSocket.CLOSED) {
      return;
    }

    this.readyState = TestWebSocket.CLOSED;
    this.emit("close", { code, reason, type: "close" });
  }

  open() {
    this.readyState = TestWebSocket.OPEN;
    this.emit("open", { type: "open" });
  }

  serverMessage(data: string) {
    this.emit("message", { data, type: "message" });
  }

  private emit(type: SocketEventType, event: SocketEvent) {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

const LABEL = "Test server";
const SOCKET_URL = "wss://server.example.test/ws?wsTicket=test";

const RequestId = Schema.Union([Schema.String, Schema.Number]);

const RpcRequest = Schema.TaggedStruct("Request", {
  id: RequestId,
  payload: Schema.Unknown,
  tag: Schema.String,
});

// Server frames as RpcSerialization.json writes them to the socket.
const ResponseChunk = Schema.TaggedStruct("Chunk", {
  requestId: RequestId,
  values: Schema.Array(Schema.Unknown),
});

const SuccessExit = Schema.TaggedStruct("Success", { value: Schema.Unknown });

const ResponseExit = Schema.TaggedStruct("Exit", { requestId: RequestId, exit: SuccessExit });

const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const isRpcRequest = Schema.is(RpcRequest);
const encodeJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const encodeNotesEvent = Schema.encodeSync(NotesStreamEvent);

const makeFactory = Effect.fn("TestRpcSessionFactory.make")(function* () {
  const sentChanges = yield* Queue.unbounded<void>();

  const sockets = Object.assign(new Array<TestWebSocket>(), {
    changes: yield* Queue.unbounded<void>(),
  });

  const layerConstructor = Layer.succeed(Socket.WebSocketConstructor, (url) => {
    const socket = new TestWebSocket(url, sentChanges);
    sockets.push(socket);
    Queue.offerUnsafe(sockets.changes, undefined);

    // SAFETY: TestWebSocket implements the members Socket.makeWebSocket uses: readyState, the
    // event listener pair, send and close.
    // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- a fake socket stands in for the DOM WebSocket class.
    return socket as unknown as globalThis.WebSocket;
  });

  const layer = RpcSession.layer.pipe(Layer.provide(layerConstructor));
  const factory = yield* RpcSession.RpcSessionFactory.pipe(Effect.provide(layer));

  return { factory, sockets };
});

const awaitSocket = Effect.fn("TestRpcSessionFactory.awaitSocket")(function* (
  sockets: ReadonlyArray<TestWebSocket> & { readonly changes: Queue.Queue<void> },
  index = 0,
) {
  for (;;) {
    const socket = sockets[index];

    if (socket) {
      return socket;
    }

    yield* Queue.take(sockets.changes);
  }
});

const awaitRequest = Effect.fn("TestRpcSessionFactory.awaitRequest")(function* (
  socket: TestWebSocket,
  index = 0,
) {
  for (;;) {
    const request = socket.sent.map((message) => decodeJson(message)).filter(isRpcRequest)[index];

    if (request) {
      return request;
    }

    yield* Queue.take(socket.sentChanges);
  }
});

const answerProbe = Effect.fn("TestRpcSessionFactory.answerProbe")(function* (
  socket: TestWebSocket,
  index: number,
) {
  const request = yield* awaitRequest(socket, index);
  expect(request.tag).toBe(WS_METHODS.serverProbe);
  expect(request.payload).toEqual({});
  socket.serverMessage(
    encodeJson(ResponseExit.make({ requestId: request.id, exit: SuccessExit.make({ value: {} }) })),
  );
});

describe("RpcSessionFactory", () => {
  it.effect("owns one scoped websocket attempt and exposes readiness and closure", () =>
    Effect.gen(function* () {
      const { factory, sockets } = yield* makeFactory();
      const session = yield* factory.connect({ label: LABEL, socketUrl: SOCKET_URL });
      const readyFiber = yield* Effect.forkChild(session.ready);
      const socket = yield* awaitSocket(sockets);

      expect(socket.url).toBe(SOCKET_URL);
      socket.open();
      yield* answerProbe(socket, 0);
      yield* Fiber.join(readyFiber);

      const probeFiber = yield* Effect.forkChild(session.probe);
      yield* answerProbe(socket, 1);
      yield* Fiber.join(probeFiber);

      expect(
        socket.sent
          .map((message) => decodeJson(message))
          .filter(isRpcRequest)
          .map((request) => request.tag),
      ).toEqual([WS_METHODS.serverProbe, WS_METHODS.serverProbe]);

      socket.close(1012, "service restart");
      const error = yield* Effect.flip(session.closed);

      expect(error).toBeInstanceOf(ConnectionTransientError);
      expect(error).toMatchObject({ reason: "transport", message: "Test server disconnected." });
      yield* Effect.yieldNow;
      expect(sockets).toHaveLength(1);
    }).pipe(Effect.scoped),
  );

  it.effect("closes the websocket when the session scope is released", () =>
    Effect.gen(function* () {
      const { factory, sockets } = yield* makeFactory();

      yield* Effect.scoped(
        Effect.gen(function* () {
          const session = yield* factory.connect({ label: LABEL, socketUrl: SOCKET_URL });
          const readyFiber = yield* Effect.forkChild(session.ready);
          const socket = yield* awaitSocket(sockets);
          socket.open();
          yield* answerProbe(socket, 0);
          yield* Fiber.join(readyFiber);
        }),
      );

      expect(sockets[0]?.readyState).toBe(TestWebSocket.CLOSED);
    }),
  );

  it.effect("keeps reading replies after closing a stream with a full buffer", () =>
    Effect.gen(function* () {
      const { factory, sockets } = yield* makeFactory();
      const session = yield* factory.connect({ label: LABEL, socketUrl: SOCKET_URL });
      const readyFiber = yield* Effect.forkChild(session.ready);
      const socket = yield* awaitSocket(sockets);
      socket.open();
      yield* answerProbe(socket, 0);
      yield* Fiber.join(readyFiber);

      const consuming = yield* Deferred.make<void>();

      const streamFiber = yield* session.client[WS_METHODS.subscribeNotes]({}).pipe(
        Stream.runForEach(() =>
          Deferred.succeed(consuming, undefined).pipe(Effect.andThen(Effect.never)),
        ),
        Effect.forkChild,
      );

      const streamRequest = yield* awaitRequest(socket, 1);
      const snapshot = encodeNotesEvent({ type: "snapshot", revision: 0, notes: [] });
      socket.serverMessage(
        encodeJson(
          ResponseChunk.make({
            requestId: streamRequest.id,
            values: Array.from({ length: 64 }, () => snapshot),
          }),
        ),
      );
      yield* Deferred.await(consuming);
      yield* Fiber.interrupt(streamFiber);

      const probeFiber = yield* Effect.forkChild(session.probe);
      yield* answerProbe(socket, 2);
      yield* Fiber.join(probeFiber);
    }).pipe(Effect.scoped),
  );
});
