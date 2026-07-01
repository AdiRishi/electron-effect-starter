// One flat table of IPC channel names shared by the main-process handlers and
// the preload bridge. Keep both sides pointing at these constants so a rename
// can't drift.

export const GET_APP_INFO_CHANNEL = "desktop:get-app-info";
export const GET_SERVER_BOOTSTRAP_CHANNEL = "desktop:get-server-bootstrap";
export const GET_BEARER_TOKEN_CHANNEL = "desktop:get-bearer-token";

export const SET_THEME_CHANNEL = "desktop:set-theme";
export const OPEN_EXTERNAL_CHANNEL = "desktop:open-external";
export const CONFIRM_CHANNEL = "desktop:confirm";
export const PICK_FOLDER_CHANNEL = "desktop:pick-folder";
export const CONTEXT_MENU_CHANNEL = "desktop:context-menu";

export const GET_UPDATE_STATE_CHANNEL = "desktop:update-get-state";
export const SET_UPDATE_CHANNEL_CHANNEL = "desktop:update-set-channel";
export const CHECK_FOR_UPDATE_CHANNEL = "desktop:update-check";
export const DOWNLOAD_UPDATE_CHANNEL = "desktop:update-download";
export const INSTALL_UPDATE_CHANNEL = "desktop:update-install";

// Push channels (main → renderer via webContents.send).
export const UPDATE_STATE_CHANNEL = "desktop:update-state";
export const MENU_ACTION_CHANNEL = "desktop:menu-action";
