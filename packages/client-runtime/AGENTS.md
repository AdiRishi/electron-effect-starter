# Client runtime

The client side of the connection: the connection supervisor and the typed RPC client, ported from [T3 Code](https://github.com/pingdotgg/t3code)'s client runtime.

- **Only the supervisor reconnects.** It owns one RPC session at a time. It retries transient failures with jittered backoff, waits out offline periods, and parks on a blocked failure, such as a rejected credential, until something changes. When the app becomes active it probes the live socket instead of replacing it, so a healthy connection survives sleep and wake.
- **A session is ready when the server answers on it.** An open socket is not enough: the supervisor publishes a session only after its first probe succeeds.
- **Features never handle reconnects.** They subscribe through `followSession`, which restarts the stream on every new session. A cause made only of transport failures ends the old stream with a logged warning, because the supervisor is replacing the session. A typed failure ends the stream unless the caller passes `onExpectedFailure`, and a defect always ends it.
