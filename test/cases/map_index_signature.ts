type Attrs = {[name: string]: string}
class X {
}

export class ViewField {
  public editorAttributeEffect: (field: ReadonlyArray<X>) => (Attrs | null)
}
