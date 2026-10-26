# Server

The Effect HTTP and WebSocket RPC server. The desktop shell and the browser are both clients of it. State ownership, the ticket flow and the session store follow [T3 Code](https://github.com/pingdotgg/t3code)'s server.

- **One server owns a state directory.** At startup the server holds an exclusive SQLite lock on `server-owner.sqlite`. A second server for the same directory exits with code 78, and the desktop shell stops restarting when it sees that code.
- **Dev state is separate.** Behind the Vite dev server, state lives under `dev/` instead of `userdata/`, so a dev run never migrates the real database.
- **Subscriptions send a snapshot, then live events.** The store stamps each change with a revision while holding a semaphore. A subscriber drops live events at or below its snapshot's revision, so it sees every change exactly once. A new stream follows the notes store.
- **Every client ends up with a session.** Sessions are HMAC-signed tokens, valid for 30 days, signed with a secret kept in the state directory.
  - Desktop: the shell writes a bootstrap token to the server on fd 3. The shell's main process exchanges it at `/oauth/token` for a bearer token and gives that to the renderer over IPC.
  - Browser: in web mode the server logs a one-time pairing URL (`#token=…`, valid 15 minutes). The page trades it at `/api/auth/browser-session` for an HttpOnly cookie. These endpoints accept browser credentials only from the server's own origin or the Vite dev origin.
  - WebSockets authenticate at the upgrade, with a 5-minute `?wsTicket=` from `/api/auth/websocket-ticket` or with the cookie. The server closes a socket when its session expires.
