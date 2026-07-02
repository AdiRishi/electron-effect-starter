# The Shell Owns The Local Server Process

The desktop shell decides the backend port, spawns the server child, and supervises it — the server never self-configures. This inverts T3 Code, where the server picks its own port (`findAvailablePort` in its CLI config) and reports back. Do not "fix" this back to the reference shape: the shell needs the port _before_ the child exists — to probe readiness, to gate revealing the window (a user must never see a window pointing at a dead backend), and to hand the renderer its connection target over the bridge. Everything the child needs to agree with the shell (port, bootstrap token) travels in the one envelope the shell writes; there is no second source of truth to drift.

Consequence: if the preferred port is taken, the backend runs on an ephemeral port chosen by the shell. Nothing may assume the default port — the renderer and readiness probe always receive the resolved URL, never derive it.
