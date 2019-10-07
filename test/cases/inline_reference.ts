type U = string | number

export const a: U = 2

type S<T> = {x: T}

export const b: S<number> = {x: 1}

class Foo {
  x = 1
}

export const c: Foo = new Foo
