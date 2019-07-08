export class ChangeSet {
  static fromJSON(
    // The change type
    ChangeType: {fromJSON: (json: any) => ChangeSet},
    // The json
    json: any): ChangeSet {
  }
}
