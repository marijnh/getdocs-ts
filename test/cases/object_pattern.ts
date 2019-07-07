export class StateField<T> {
  constructor({init, apply}: {
    init: (state: number[]) => T,
    apply: (tr: Object, value: T, newState: number[]) => T
  }) {
  }
}
