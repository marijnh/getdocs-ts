export class X {
  iter(dir: 1 | -1 = 1): TextIterator { return new RawTextCursor(this, dir) }
}
