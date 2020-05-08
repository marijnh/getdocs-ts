export type Foo = {a: number, b: string}

export const x: {[Type in keyof Foo]: number} = null as any
