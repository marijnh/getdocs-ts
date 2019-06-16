const unique = function<Spec>(instantiate: (specs: Spec[]) => boolean): (spec: Spec) => boolean {
  return s => instantiate([s])
}

export interface Config { value: boolean }

export const f = unique((configs: Config[]) => configs[0].value)
