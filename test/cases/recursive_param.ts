export interface A<T extends B | string = B | string> {}
export type B = ((props: any) => A<any>) | ((props: any) => any)
