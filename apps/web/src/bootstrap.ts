import { showBootError } from "./lib/bootError";

// Catch module-load and startup failures before React mounts, where no error boundary exists.
void import("./main").then(({ startup }) => startup).catch(showBootError);
