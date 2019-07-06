export type Attrs = {[name: string]: string}

export class ViewField {
  public editorAttributeEffect: (field: ReadonlyArray<RegExp>) => (Attrs | null)
}
