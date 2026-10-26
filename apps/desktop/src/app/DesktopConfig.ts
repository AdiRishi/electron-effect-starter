import * as Config from "effect/Config";
import * as Option from "effect/Option";

export const DesktopConfig = Config.all({
  devServerUrl: Config.URL("VITE_DEV_SERVER_URL").pipe(Config.option),
  configuredBackendPort: Config.Port("APP_PORT").pipe(Config.option),
  disableAutoUpdate: Config.Boolean("APP_DISABLE_AUTO_UPDATE").pipe(
    Config.option,
    Config.map(Option.getOrElse(() => false)),
  ),
});
