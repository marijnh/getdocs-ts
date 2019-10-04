export abstract class Foo {
  a() { return 1 }
  abstract b(): number
  c() { return 3 }
  d() { return 4 }
}

export class Bar extends Foo {
  a() { return 5 }
  b() { return 6 }
  /// With a doc comment
  d() { return 7 }
}
