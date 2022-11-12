type A = {
    foo: number;
    bar: string;
}

export type B = Pick<A, 'foo'>

export type C = Omit<A, 'bar'>
