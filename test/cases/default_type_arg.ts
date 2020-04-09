export class Foo<T = number, V = T[]> {
  constructor(readonly value: T, readonly content: V) {}
}

export let x = new Foo(2, [2])
export let y = new Foo(2, "hello")
export let z = new Foo("oh", ["wow"])
