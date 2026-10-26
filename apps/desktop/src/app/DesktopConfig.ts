import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Option from "effect/Option";

const compactEnv = (env: Readonly<Record<string, string | undefined>>): Record<string, string> =>
  Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );

export const DesktopConfig = Config.all({
  devServerUrl: Config.URL("VITE_DEV_SERVER_URL").pipe(Config.option),
  configuredBackendPort: Config.Port("APP_PORT").pipe(Config.option),
  disableAutoUpdate: Config.Boolean("APP_DISABLE_AUTO_UPDATE").pipe(
    Config.option,
    Config.map(Option.getOrElse(() => false)),
  ),
});

export const layerTest = (env: Readonly<Record<string, string | undefined>>) =>
  ConfigProvider.layer(ConfigProvider.fromEnv({ env: compactEnv(env) }));
