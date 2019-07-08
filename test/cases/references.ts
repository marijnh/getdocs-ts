export type Point<T> = {x: T, y: T}

export const p: Point<number> = {x: 1, y: 2}

export class Foo implements Point<string> {
  get x() { return "1" }
  get y() { return "2" }
  get z() { return "0" }
}

export const f: Foo = new Foo

export interface Bar<T> { a: T }

export const b: Bar<null> = {a: null}
