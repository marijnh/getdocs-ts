export type InferParams<T> = T extends Array<infer U> ? U : never
