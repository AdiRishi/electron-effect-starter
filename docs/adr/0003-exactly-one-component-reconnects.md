# Exactly One Component Reconnects

In the client transport, the connection supervisor is the _only_ thing that retries. The RPC protocol layer has its retries explicitly disabled (`retryTransientErrors: false`, `Schedule.recurs(0)`) and every session is single-use: when a socket drops, the session just fails its `closed` effect and the supervisor rebuilds a whole fresh session after capped backoff. Do not enable retries at the protocol layer or make sessions reusable — two layers retrying against each other is how reconnect storms and half-alive sessions happen.

Two non-obvious corollaries of this design:

- **Credential minting lives inside the reconnect loop** (`prepareSocketUrl` runs at the top of every attempt). A failed mint — server not up yet, stale token — is just another transient failure to back off from, not a gate in front of the loop. This is why a browser opened before the server starts converges on "Connected" with no special cases.
- **Streaming subscriptions classify failures.** `subscribe` re-attaches onto each fresh session automatically, so _transport_ failures (`RpcClientError`) are logged and swallowed — re-attach is the recovery. _Domain_ failures (the server rejected the subscription) propagate to the consumer. Both halves are deliberate and pinned by tests in `rpc/client.test.ts`; collapsing them either way is a regression — swallow everything and server rejections become silently-empty streams, propagate everything and every network blip kills long-lived subscriptions.
