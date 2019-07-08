type U = string | number

export const a: U = 2

type S<T> = {x: T}

export const b: S<number> = {x: 1}
