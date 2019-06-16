export abstract class Text {
  abstract readonly children: ReadonlyArray<Text> | null

  // @internal
  abstract decomposeStart(to: number, target: Text[]): void
}
