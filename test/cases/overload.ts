export class Foo {
  m(): undefined
  m<T>(x: T): T
  m<T>(x?: T) { return x }
}

export function f(a: number): string
export function f(a: number, b: number): number
export function f(a: number, b?: number): string | number {
  return b == null ? "oh no" : a + b
}
