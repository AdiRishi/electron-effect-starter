# One Web Build Runs In Both Hosts

There is a single renderer build, and it must run unchanged in the Electron shell _and_ in a plain browser pointed at the local server. All host difference is confined to one seam — the `LocalApi` surface — which delegates to the preload bridge when present and degrades to web equivalents (`window.open`, `window.confirm`, `localStorage`, no folder picker) when not. Components never branch on the host.

The rule this imposes on future work: **adding a bridge capability includes defining its browser degradation.** If a capability cannot degrade (it would make the browser build unusable rather than merely less capable), that is a signal it belongs behind an RPC on the server, not on the bridge. This constraint is what keeps the dev loop (renderer in a plain browser with HMR, no shell launch) and the packaged app (served same-origin by the local server) running the same code.
