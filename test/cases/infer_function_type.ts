function f<T>(a: T) {
  return () => a
}

export const x = f(1)
