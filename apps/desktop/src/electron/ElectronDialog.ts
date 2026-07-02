import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as Electron from "electron";

const CONFIRM_BUTTON_INDEX = 1;

export class ElectronDialogPickFolderError extends Schema.TaggedErrorClass<ElectronDialogPickFolderError>()(
  "ElectronDialogPickFolderError",
  {
    ownerWindowId: Schema.NullOr(Schema.Number),
    defaultPath: Schema.NullOr(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    const owner = this.ownerWindowId === null ? "the application" : `window ${this.ownerWindowId}`;
    return `Failed to open the Electron folder picker for ${owner}.`;
  }
}

export class ElectronDialogConfirmError extends Schema.TaggedErrorClass<ElectronDialogConfirmError>()(
  "ElectronDialogConfirmError",
  {
    ownerWindowId: Schema.NullOr(Schema.Number),
    promptLength: Schema.Number,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    const owner = this.ownerWindowId === null ? "the application" : `window ${this.ownerWindowId}`;
    return `Failed to open an Electron confirmation dialog for ${owner}.`;
  }
}

export interface ElectronDialogPickFolderInput {
  readonly owner: Option.Option<Electron.BrowserWindow>;
  readonly defaultPath: Option.Option<string>;
  readonly title: Option.Option<string>;
}

export interface ElectronDialogConfirmInput {
  readonly owner: Option.Option<Electron.BrowserWindow>;
  readonly message: string;
}

export class ElectronDialog extends Context.Service<
  ElectronDialog,
  {
    readonly pickFolder: (
      input: ElectronDialogPickFolderInput,
    ) => Effect.Effect<Option.Option<string>, ElectronDialogPickFolderError>;
    readonly confirm: (
      input: ElectronDialogConfirmInput,
    ) => Effect.Effect<boolean, ElectronDialogConfirmError>;
    readonly showErrorBox: (title: string, content: string) => Effect.Effect<void>;
  }
>()("@app/desktop/electron/ElectronDialog") {}

export const make = ElectronDialog.of({
  pickFolder: Effect.fn("desktop.electron.dialog.pickFolder")(function* (input) {
    const ownerWindowId = Option.match(input.owner, {
      onNone: () => null,
      onSome: (owner) => owner.id,
    });
    const defaultPath = Option.getOrNull(input.defaultPath);
    const openDialogOptions: Electron.OpenDialogOptions = {
      properties: ["openDirectory", "createDirectory"],
      ...(defaultPath === null ? {} : { defaultPath }),
      ...Option.match(input.title, {
        onNone: () => ({}),
        onSome: (title) => ({ title }),
      }),
    };
    const result = yield* Effect.tryPromise({
      try: () =>
        Option.match(input.owner, {
          onNone: () => Electron.dialog.showOpenDialog(openDialogOptions),
          onSome: (owner) => Electron.dialog.showOpenDialog(owner, openDialogOptions),
        }),
      catch: (cause) =>
        new ElectronDialogPickFolderError({
          ownerWindowId,
          defaultPath,
          cause,
        }),
    });

    if (result.canceled) {
      return Option.none();
    }
    return Option.fromNullishOr(result.filePaths[0]);
  }),
  confirm: Effect.fn("desktop.electron.dialog.confirm")(function* (input) {
    const normalizedMessage = input.message.trim();
    if (normalizedMessage.length === 0) {
      return false;
    }
    const options = {
      type: "question" as const,
      buttons: ["No", "Yes"],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
      message: normalizedMessage,
    };
    const ownerWindowId = Option.match(input.owner, {
      onNone: () => null,
      onSome: (owner) => owner.id,
    });
    const result = yield* Effect.tryPromise({
      try: () =>
        Option.match(input.owner, {
          onNone: () => Electron.dialog.showMessageBox(options),
          onSome: (owner) => Electron.dialog.showMessageBox(owner, options),
        }),
      catch: (cause) =>
        new ElectronDialogConfirmError({
          ownerWindowId,
          promptLength: normalizedMessage.length,
          cause,
        }),
    });
    return result.response === CONFIRM_BUTTON_INDEX;
  }),
  showErrorBox: (title, content) =>
    Effect.try({
      try: () => Electron.dialog.showErrorBox(title, content),
      catch: (cause) => cause,
    }).pipe(Effect.ignore),
});

export const layer = Layer.succeed(ElectronDialog, make);
