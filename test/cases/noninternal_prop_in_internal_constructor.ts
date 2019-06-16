export class Extension {
  // @internal
  constructor(public kind: Kind,
              /* @internal */ public id: any,
              /* @internal */ public value: any,
              /* @internal */ public priority: number = -2) {}
}
