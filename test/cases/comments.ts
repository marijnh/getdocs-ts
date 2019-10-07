/// Shouldn't appear
const a = 1

/// Should appear
export const y = a

export class X {
  /// Should be
  ///separate lines
  x: number

  /// Several comments

  /// With blank lines

  /** Between them */
  y: boolean
}
