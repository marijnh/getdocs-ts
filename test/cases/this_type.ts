export interface TextIterator extends Iterator<string> {
  next(skip?: number): this
}
