let y = 0
export class X {
  // This is get x
  get x() { return 5 }
  // This is get y
  get y() { return y }
  // This is set y
  set y(newY: number) { y = newY }
  // This is static get x
  static get x() { return 5 }
  static get y() { return y }
  // This is static set y
  static set y(newY: number) { y = newY }
}
