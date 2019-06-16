let y = 0
export class X {
  get x() { return 5 }
  get y() { return y }
  set y(newY: number) { y = newY }
  static get x() { return 5 }
  static get y() { return y }
  static set y(newY: number) { y = newY }
}
