export class StateField<T> {
  constructor({init, apply}: {
    init: (state: EditorState) => T,
    apply: (tr: Transaction, value: T, newState: EditorState) => T
  }) {
  }
}
