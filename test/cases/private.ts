export class EditorState {
  /** @internal */
  constructor(/** @internal */ readonly config: Configuration,
              private readonly fields: ReadonlyArray<any>) {}
}
