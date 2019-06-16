export class Extension {
  static all(...extensions: Extension[]) {
    return new this(Kind.MULTI, null, extensions)
  }
}
