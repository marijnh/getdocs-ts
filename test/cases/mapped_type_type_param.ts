export type Full<T> = {[K in keyof T]-?: T[K]}
