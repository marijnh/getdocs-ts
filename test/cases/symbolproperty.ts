declare const sym: unique symbol

export type O = {
  [sym]: number,
  [Symbol.iterator]: string
}
