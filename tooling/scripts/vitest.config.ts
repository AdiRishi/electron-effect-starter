import { defineConfig, mergeConfig } from "vitest/config";

import shared from "@app/vitest-config";

export default mergeConfig(shared, defineConfig({}));
