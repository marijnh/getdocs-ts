export class X {
  iter(dir: 1 | -1 = 1): TextIterator { }
  movePos(start: number, direction: "forward" | "backward" | "left" | "right",
          granularity: "character" | "word" | "line" | "lineboundary" = "character",
          action: "move" | "extend" = "move"): number { return 0 }
}

import {TextIterator} from "./this_type"
