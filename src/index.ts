import {
  getCombinedModifierFlags, findConfigFile, createCompilerHost, getParsedCommandLineOfConfigFile, createProgram, sys,
  getEffectiveConstraintOfTypeParameter,
  getLineAndCharacterOfPosition, isWhiteSpaceLike, isLineBreak,
  isClassLike, isInterfaceDeclaration,
  TypeChecker,
  Symbol, SymbolFlags, ModifierFlags,
  Type, TypeFlags, ObjectType, TypeReference, ObjectFlags, LiteralType, UnionOrIntersectionType, ConditionalType,
  Signature, IndexType, IndexedAccessType,
  Node, SyntaxKind, UnionOrIntersectionTypeNode, MappedTypeNode, TypeOperatorNode,
  Declaration, NamedDeclaration, TypeParameterDeclaration, ParameterDeclaration, EnumDeclaration, VariableDeclaration, ConstructorDeclaration
} from "typescript"

import {resolve, dirname, relative, sep} from "path"

type BindingKind = "class" | "enum" | "enummember" | "interface" | "variable" | "property" | "method" |
  "typealias" | "typeparam" | "constructor" | "function" | "parameter" | "reexport"

type Loc = {file: string, line: number, column: number}

type Binding = {
  kind: BindingKind,
  id: string,
  description?: string,
  loc?: Loc,
  abstract?: boolean,
  readonly?: boolean,
  optional?: boolean
}

type BindingType = {
  type: string,
  typeSource?: string, // missing means this is a built-in type
  typeParamSource?: string,
  properties?: {[name: string]: Item},
  instanceProperties?: {[name: string]: Item},
  typeArgs?: readonly BindingType[],
  typeParams?: readonly Param[],
  params?: readonly Param[],
  returns?: BindingType,
  // Used by mapped types
  key?: Param,
  overloaded?: readonly BindingType[],
  extends?: BindingType,
  implements?: readonly BindingType[],
  construct?: Item
}

type Param = BindingType & {
  name?: string,
  id: string,
  description?: string,
  loc?: Loc,
  optional?: boolean,
  rest?: boolean,
  default?: string
}

type Item = Binding & BindingType

// Used for recursion check in getObjectType
const gettingObjectTypes: Type[] = []

class Context {
  constructor(readonly tc: TypeChecker,
              readonly exports: readonly Symbol[],
              readonly basedir: string,
              readonly id: string,
              readonly typeParams: Param[]) {}

  extend(symbol: Symbol | string, sep = "^") {
    let nm = typeof symbol == "string" ? symbol : symbol.name
    return new Context(this.tc, this.exports, this.basedir, this.id ? this.id + sep + nm : nm, this.typeParams)
  }

  addParams(typeParams: Param[]) {
    return new Context(this.tc, this.exports, this.basedir, this.id, typeParams.concat(this.typeParams))
  }

  gatherSymbols(symbols: readonly Symbol[], target: {[name: string]: Item} = {}, sep = ".",
                filter?: (name: string, value: Item) => boolean) {
    let gathered = 0
    for (const symbol of symbols.slice().sort(compareSymbols)) {
      let name = this.symbolName(symbol)
      let item = this.extend(name, sep).itemForSymbol(symbol)
      if (item && (!filter || filter(name, item))) {
        target[name] = item
        gathered++
      }
    }
    return gathered ? target : null
  }

  symbolName(symbol: Symbol) {
    if (!/^__@/.test(symbol.name)) return symbol.name
    let name = symbol.name.slice(3)
    return /@/.test(name) ? "[unique symbol]" : `[symbol ${name}]`
  }

  itemForSymbol(symbol: Symbol, kind?: BindingKind): Item | null {
    if (kind) {
      // Kind given
    } else if (symbol.flags & SymbolFlags.Alias) {
      let aliased = this.tc.getAliasedSymbol(symbol)
      if (this.isExternal(aliased)) kind = "reexport"
      else return this.itemForSymbol(aliased)
    }
    else if (symbol.flags & SymbolFlags.PropertyOrAccessor) kind = "property"
    else if (symbol.flags & SymbolFlags.Method) kind = "method"
    else if (symbol.flags & SymbolFlags.Enum) kind = "enum"
    else if (symbol.flags & SymbolFlags.EnumMember) kind = "enummember"
    else if (symbol.flags & SymbolFlags.Class) kind = "class"
    else if (symbol.flags & SymbolFlags.Function) kind = "function"
    else if (symbol.flags & SymbolFlags.Interface) kind = "interface"
    else if (symbol.flags & SymbolFlags.TypeAlias) kind = "typealias"
    else if (symbol.flags & SymbolFlags.Variable) kind = "variable"
    else if (symbol.flags & SymbolFlags.TypeParameter) kind = "typeparam"
    else throw new Error(`Can not determine a kind for symbol ${symbol.escapedName} with flags ${symbol.flags}`)

    let binding: Binding = {kind, id: this.id}, type = this.symbolType(symbol)
    this.addSourceData(symbol.declarations || [], binding)

    let mods = symbol.valueDeclaration ? getCombinedModifierFlags(symbol.valueDeclaration) : 0
    if (mods & ModifierFlags.Abstract) binding.abstract = true
    if ((mods & ModifierFlags.Readonly) ||
        ((symbol.flags & (SymbolFlags.GetAccessor | SymbolFlags.SetAccessor)) == SymbolFlags.GetAccessor))
      binding.readonly = true
    if ((mods & ModifierFlags.Private) || binding.description && /@internal\b/.test(binding.description)) return null
    if (symbol.flags & SymbolFlags.Optional) {
      binding.optional = true
      type = this.tc.getNonNullableType(type)
    }

    let cx: Context = this
    let params = this.getTypeParams(decl(symbol))
    if (params) cx = cx.addParams(params)
    let typeDesc = kind == "enum" ? cx.getEnumType(symbol)
      : kind == "reexport" ? cx.getReferenceType(this.tc.getAliasedSymbol(symbol))
      : cx.getType(type, symbol)
    if (params) typeDesc.typeParams = params

    return {...binding, ...typeDesc}
  }

  getEnumType(symbol: Symbol): BindingType {
    let properties: {[name: string]: Item} = {}
    this.gatherSymbols((decl(symbol) as EnumDeclaration).members
                       .map(member => this.tc.getSymbolAtLocation(member.name)!), properties)
    for (let n in properties) {
      properties[n].type = symbol.name
      properties[n].typeSource = this.nodePath(decl(symbol))
    }
    return {type: "enum", properties}
  }

  getType(type: Type, forSymbol?: Symbol): BindingType {
    if (type.aliasSymbol && !(forSymbol && (forSymbol.flags & SymbolFlags.TypeAlias)) && this.isAvailable(type.aliasSymbol))
      return this.getReferenceType(type.aliasSymbol, type.aliasTypeArguments)

    if (type.flags & TypeFlags.Any) return {type: "any"}
    if (type.flags & TypeFlags.String) return {type: "string"}
    if (type.flags & TypeFlags.Number) return {type: "number"}
    if (type.flags & TypeFlags.BigInt) return {type: "BigInt"}
    if (type.flags & TypeFlags.ESSymbol) return {type: "Symbol"}
    if (type.flags & TypeFlags.Boolean) return {type: "boolean"}
    if (type.flags & TypeFlags.Undefined) return {type: "undefined"}
    if (type.flags & TypeFlags.Null) return {type: "null"}
    // FIXME TypeScript doesn't export this. See https://github.com/microsoft/TypeScript/issues/26075, where they intend to fix that
    if (type.flags & TypeFlags.BooleanLiteral) return {type: (type as any).intrinsicName}
    if (type.flags & TypeFlags.Literal) return {type: JSON.stringify((type as LiteralType).value)}
    if (type.flags & TypeFlags.Never) return {type: "never"}

    if (type.flags & TypeFlags.UnionOrIntersection) {
      let types = (type as UnionOrIntersectionType).types, decl
      // If we have a decl, use the order from that, since TypeScript 'normalizes' it in the type object
      if (forSymbol && (decl = maybeDecl(forSymbol))) {
        let typeNode = (decl as VariableDeclaration).type
        if (typeNode && (typeNode.kind == SyntaxKind.UnionType || typeNode.kind == SyntaxKind.IntersectionType))
          types = (typeNode as UnionOrIntersectionTypeNode).types.map(node => this.tc.getTypeAtLocation(node))
      }
      return {
        type: type.flags & TypeFlags.Union ? "union" : "intersection",
        typeArgs: types.map(type => (type.flags & TypeFlags.Void) ? {type: "undefined"} : this.getType(type))
      }
    }

    if (type.flags & TypeFlags.TypeParameter) {
      let name = type.symbol.name, found = this.typeParams.find(p => p.name == name)
      if (!found) throw new Error(`Unknown type parameter ${name}`)
      return {type: name, typeParamSource: found.id}
    }

    if (type.flags & TypeFlags.Index) {
      return {type: "keyof", typeArgs: [this.getType((type as IndexType).type)]}
    }

    if (type.flags & TypeFlags.IndexedAccess) {
      return {type: "indexed", typeArgs: [this.getType((type as IndexedAccessType).objectType),
                                          this.getType((type as IndexedAccessType).indexType)]}
    }

    if (type.flags & TypeFlags.Conditional) {
      let {root} = type as ConditionalType
      return {type: "conditional",
              typeArgs: [this.getType(root.checkType), this.getType(root.extendsType),
                         this.getType(root.trueType), this.getType(root.falseType)]}
    }

    if (type.flags & TypeFlags.Object) {
      let objFlags = (type as ObjectType).objectFlags

      if (forSymbol && (forSymbol.flags & SymbolFlags.Class)) return this.getClassType(type as ObjectType)
      if (forSymbol && (forSymbol.flags & SymbolFlags.Interface)) return this.getObjectType(type as ObjectType, forSymbol)

      if ((objFlags & (ObjectFlags.Reference | ObjectFlags.Interface)) &&
          type.symbol && this.isAvailable(type.symbol))
        return this.getReferenceType(type.symbol, (type as TypeReference).typeArguments, type)

      // Tuples have a weird structure where they point as references at a generic tuple type
      if (objFlags & ObjectFlags.Reference) {
        let target = (type as TypeReference).target
        if ((target.flags & TypeFlags.Object) && ((target as ObjectType).objectFlags & ObjectFlags.Tuple))
          return {type: "tuple", typeArgs: (type as TypeReference).typeArguments!.map(t => this.getType(t))}
      }
      if (objFlags & ObjectFlags.Mapped) {
        let decl = maybeDecl(type.symbol) as MappedTypeNode, innerType = decl && decl.type
        let typeParam = decl && decl.typeParameter ? this.getTypeParam(decl.typeParameter) : null
        let cx = typeParam ? this.addParams([typeParam]) : this
        let result: BindingType = {
          type: typeParam ? "mapped" : "Object",
          typeArgs: [innerType ? cx.getType(this.tc.getTypeAtLocation(innerType)) : {type: "any"}]
        }
        if (typeParam) result.key = typeParam
        return result
      }

      let call = type.getCallSignatures()
      if (call.length) {
        let main = this.addCallSignature(call[0], {type: "Function"})
        if (call.length > 1) main.overloaded = call.slice(1).map(sig => this.addCallSignature(sig, {type: "Function"}))
        return main
      }

      // See `createAnonymousTypeNode` for more fine-grained `typeof` conditionals
      if ((type.symbol.flags & (SymbolFlags.Class | SymbolFlags.Enum | SymbolFlags.ValueModule)) &&
          this.isAvailable(type.symbol))
        return {type: "typeof", typeArgs: [this.getReferenceType(type.symbol)]}
      return this.getObjectType(type as ObjectType)
    }
    if (type.flags & TypeFlags.Unknown) return {type: "unknown"}

    let maybePath = ""
    let maybeD, maybeS = forSymbol || type.symbol
    if (maybeD = maybeS && maybeDecl(maybeS)) {
      let pos = getLineAndCharacterOfPosition(maybeD.getSourceFile(), maybeD.pos)
      maybePath = ` at ${this.nodePath(maybeD)}:${pos.line - 1}:${pos.character - 1}`
    }
    throw new Error(`Unsupported type ${this.tc.typeToString(type)} with flags ${type.flags}${maybePath}`)
  }

  getObjectType(type: ObjectType, interfaceSymbol?: Symbol): BindingType {
    if (gettingObjectTypes.includes(type)) return {type: "Object"}
    gettingObjectTypes.push(type)
    let out: BindingType = {type: interfaceSymbol ? "interface" : "Object"}

    let call = type.getCallSignatures(), props = type.getProperties()
    let strIndex = type.getStringIndexType(), numIndex = type.getNumberIndexType(), indexSym
    let intDecl = interfaceSymbol && maybeDecl(interfaceSymbol)
    if (intDecl && isInterfaceDeclaration(intDecl)) {
      let declared = intDecl.members.filter(member => member.name).map(member => this.tc.getSymbolAtLocation(member.name!)!.name)
      props = props.filter(prop => declared.includes(prop.name))
      if (strIndex || numIndex) for (let member of intDecl.members)
        if (member.kind == SyntaxKind.IndexSignature && (member as any).symbol)
          indexSym = (member as any).symbol as Symbol
      if (intDecl.heritageClauses && intDecl.heritageClauses.length)
        out.implements = intDecl.heritageClauses[0].types.map(node => this.getType(this.tc.getTypeAtLocation(node)))
    }
    if (!props.length && !call.length) {
      if (strIndex) return {type: "Object", typeArgs: [this.getType(strIndex)]}
      if (numIndex) return {type: "Array", typeArgs: [this.getType(numIndex)]}
    }

    if (call.length) this.addCallSignature(call[0], out)
    let propObj = this.gatherSymbols(props)
    if (indexSym) {
      let name = strIndex ? "string" : "number", item = this.extend(name).itemForSymbol(indexSym, "property")
      if (item) (propObj || (propObj = {}))[`[${name}]`] = item
    }
    if (propObj) out.properties = propObj
    gettingObjectTypes.pop()
    return out
  }

  getClassType(type: ObjectType): BindingType {
    let out: BindingType = {type: "class"}
    let classDecl = type.symbol.valueDeclaration
    if (!isClassLike(classDecl)) throw new Error("Class decl isn't class-like")

    let parentProps: string[] = []
    if (classDecl.heritageClauses) {
      for (let heritage of classDecl.heritageClauses) {
        let parents = heritage.types.map(node => {
          let type = this.tc.getTypeAtLocation(node)
          for (let sym of type.getProperties()) parentProps.push(sym.name)
          return this.getType(type)
        })
        if (heritage.token == SyntaxKind.ExtendsKeyword) out.extends = parents[0]
        else out.implements = parents
      }
    }

    let definedProps: string[] = [], definedStatic: string[] = [], ctors: Declaration[] = []
    for (let member of classDecl.members) {
      let symbol = this.tc.getSymbolAtLocation(member.name || member)!
      if (member.kind == SyntaxKind.Constructor) {
        ctors.push(member)
        for (let param of (member as ConstructorDeclaration).parameters) {
          if (getCombinedModifierFlags(param) & (ModifierFlags.Public | ModifierFlags.Readonly))
            definedProps.push(this.tc.getSymbolAtLocation(param.name)!.name)
        }
      } else if (getCombinedModifierFlags(member) & ModifierFlags.Static) {
        definedStatic.push(symbol.name)
      } else {
        definedProps.push(symbol.name)
      }
    }

    for (let ctor of ctors) {
      let signature = type.getConstructSignatures().find(sig => sig.getDeclaration() == ctor)
      if (!signature || (getCombinedModifierFlags(ctor) & ModifierFlags.Private)) continue
      let item: Binding = {kind: "constructor", id: this.id + ".constructor"}
      this.addSourceData([ctor], item)
      if (item.description && /@internal\b/.test(item.description)) continue
      out.construct = {...item, type: "Function", params: this.extend("constructor", ".").getParams(signature)}
      break
    }

    // FIXME I haven't found a less weird way to get the instance type
    let ctorType = type.getConstructSignatures()[0]
    if (ctorType) {
      let protoProps = ctorType.getReturnType().getProperties().filter(prop => definedProps.includes(prop.name))
      let instanceObj = this.gatherSymbols(protoProps, undefined, undefined, (name, value) => {
        return !!value.description || !parentProps.includes(name)
      })
      if (instanceObj) out.instanceProperties = instanceObj
    }

    let props = type.getProperties().filter(prop => definedStatic.includes(prop.name))
    let propObj = this.gatherSymbols(props, undefined, "^")
    if (propObj) out.properties = propObj

    return out
  }

  getReferenceType(symbol: Symbol, typeArgs?: readonly Type[], arityType?: Type) {
    let result: BindingType = {type: symbol.name}
    let typeSource = this.nodePath(decl(symbol))
    if (!isBuiltin(typeSource)) result.typeSource = typeSource
    if (typeArgs) {
      let targetParams = arityType ? (arityType as TypeReference).target.typeParameters : null
      if (arityType) typeArgs = typeArgs.slice(0, targetParams ? targetParams.length : 0)
      if (typeArgs.length) {
        let args = typeArgs.map(arg => this.getType(arg))
        // If there are default types for the type parameters, drop
        // types that match the default from the list of arguments to
        // reduce noise.
        if (targetParams) {
          let cx: Context | null = null
          for (let i = targetParams.length - 1; i >= 0; i--) {
            let deflt = targetParams[i].getDefault()
            if (!deflt) break
            if (!cx) cx = this.addParams(args.map((a, i) => Object.assign({
              name: targetParams![i].symbol.name,
              id: String(i)
            }, a)))
            let compare = cx.getType(deflt)
            if (compareTypes(args[i], compare, args as any)) args.pop()
            else break
          }
        }
        if (args.length) result.typeArgs = args
      }
    }
    return result
  }

  getParams(signature: Signature): Param[] {
    return signature.getParameters().map(param => {
      let cx = this.extend(param), optional = false, type = cx.symbolType(param)
      let decl = param.valueDeclaration as (ParameterDeclaration | undefined)
      if (decl && decl.questionToken) {
        optional = true
        type = this.tc.getNonNullableType(type)
      }
      let result: Param = {
        id: cx.id,
        ...cx.getType(type, param)
      }

      if (decl) this.addSourceData([decl], result, !(getCombinedModifierFlags(decl) & (ModifierFlags.Public | ModifierFlags.Readonly)))
      let deflt: Node = decl && (decl as any).initializer
      if (deflt) result.default = deflt.getSourceFile().text.slice(deflt.pos, deflt.end).trim()
      if (deflt || optional) result.optional = true
      if (decl && decl.dotDotDotToken) result.rest = true
      if ((param.valueDeclaration as NamedDeclaration).name!.kind == SyntaxKind.Identifier) result.name = param.name
      return result
    })
  }

  getTypeParams(decl: Node): Param[] | null {
    let params = (decl as any).typeParameters as TypeParameterDeclaration[]
    return !params ? null : params.reduce(([res, cx]: [Param[], Context], param): [Param[], Context] => {
      let p = cx.getTypeParam(param)
      return [res.concat(p), cx.addParams([p])]
    }, [[], this])[0]
  }

  getTypeParam(param: TypeParameterDeclaration): Param {
    let sym = this.tc.getSymbolAtLocation(param.name)!
    let localCx = this.extend(sym)
    let result: Param = {type: "typeparam", name: sym.name, id: localCx.id}
    this.addSourceData([param], result)
    let constraint = getEffectiveConstraintOfTypeParameter(param), type
    // Directly querying getTypeAtLocation for the constraint will
    // resolve keyof types for some reason, which can lead to very
    // ugly and verbose output. So this inspects the type node for
    // that case and manually handles it.
    if (constraint && constraint.kind == SyntaxKind.TypeOperator &&
        (constraint as TypeOperatorNode).operator == SyntaxKind.KeyOfKeyword &&
        (type = localCx.tc.getTypeAtLocation((constraint as TypeOperatorNode).type)))
      result.implements = [{type: "keyof", typeArgs: [this.getType(type)]}]
    else if (constraint && (type = localCx.tc.getTypeAtLocation(constraint)))
      result.implements = [localCx.getType(type)]
    if (param.default)
      result.default = param.getSourceFile().text.slice(param.default.pos, param.default.end).trim()
    return result
  }

  addCallSignature(signature: Signature, target: BindingType) {
    let cx: Context = this
    let typeParams = signature.typeParameters && this.getTypeParams(signature.getDeclaration())
    if (typeParams) {
      cx = cx.addParams(typeParams)
      target.typeParams = typeParams
    }
    target.params = cx.getParams(signature)
    let ret = signature.getReturnType()
    if (!(ret.flags & TypeFlags.Void)) target.returns = cx.extend("returns").getType(ret)
    return target
  }

  symbolType(symbol: Symbol) {
    let type = this.tc.getTypeOfSymbolAtLocation(symbol, decl(symbol))
    // FIXME this is weird and silly but for interface declarations TS gives a symbol type of any
    if (type.flags & TypeFlags.Any) type = this.tc.getDeclaredTypeOfSymbol(symbol)
    return type
  }

  nodePath(node: Node) {
    return relative(process.cwd(), node.getSourceFile().fileName)
  }

  addSourceData(nodes: readonly Node[], target: Binding | Param, comments = true) {
    if (comments) {
      let comment = ""
      for (let node of nodes) {
        let c = getComments(node.kind == SyntaxKind.VariableDeclaration ? node.parent.parent : node)
        if (c) comment += (comment ? "\n\n" : "") + c
      }
      if (comment) target.description = comment
    }
    const sourceFile = nodes[0].getSourceFile()
    if (!sourceFile) return // Synthetic node
    let {pos} = nodes[0]
    while (isWhiteSpaceLike(sourceFile.text.charCodeAt(pos))) ++pos
    const {line, character} = getLineAndCharacterOfPosition(sourceFile, pos)
    target.loc = {file: this.nodePath(nodes[0]), line: line + 1, column: character}
  }

  // Tells whether a symbol is either exported or external, and thus
  // can be used in the output
  isAvailable(symbol: Symbol) {
    return this.exports.includes(symbol) || this.isExternal(symbol)
  }

  isExternal(symbol: Symbol) {
    let decl = maybeDecl(symbol)
    if (!decl) return true
    let path = resolve(decl.getSourceFile().fileName)
    return !path.startsWith(this.basedir + sep) || /\bnode_modules\b/.test(path.slice(this.basedir.length))
  }
}

function maybeDecl(symbol: Symbol): Declaration | undefined {
  return symbol.valueDeclaration || (symbol.declarations && symbol.declarations[0])
}

function decl(symbol: Symbol) {
  let result = maybeDecl(symbol)
  if (!result) throw new Error(`No declaration available for symbol ${symbol.escapedName}`)
  return result
}

function isBuiltin(path: string) {
  return /typescript\/lib\/.*\.es\d+.*\.d\.ts$/.test(path)
}

function compareSymbols(a: Symbol, b: Symbol) {
  let da = maybeDecl(a), db = maybeDecl(b)
  if (!da) return db ? -1 : 0
  if (!db) return 1
  let fa = da.getSourceFile().fileName, fb = db.getSourceFile().fileName
  return fa == fb ? da.pos - db.pos : fa < fb ? -1 : 1
}

function compareTypes(a: BindingType, b: BindingType, paramMap: {[id: string]: BindingType}) {
  while (b.typeParamSource && paramMap[b.typeParamSource]) b = paramMap[b.typeParamSource]
  if (a.type != b.type || a.typeSource != b.typeSource || a.typeParamSource != b.typeParamSource ||
      !a.properties != !b.properties || a.instanceProperties || b.instanceProperties ||
      !a.typeArgs != !b.typeArgs || !a.params != !b.params || !a.returns != !b.returns) return false
  if (a.properties) {
    let aK = Object.keys(a.properties), bK = Object.keys(b.properties!)
    if (aK.length != bK.length || !aK.every(k => b.properties![k] || compareTypes(a.properties![k], b.properties![k], paramMap)))
      return false
  }
  if (a.typeArgs && (a.typeArgs.length != b.typeArgs!.length ||
                     !a.typeArgs.every((ta, i) => compareTypes(ta, b.typeArgs![i], paramMap)))) return false
  if (a.params && (a.params.length != b.params!.length ||
                   !a.params.every((p, i) => compareTypes(p, b.params![i], paramMap)))) return false
  if (a.returns && !compareTypes(a.returns, b.returns!, paramMap)) return false
  return true
}

function getComments(node: Node) {
  let {pos} = node
  const sourceFile = node.getSourceFile()
  if (!sourceFile) return "" // Synthetic node
  const {text} = sourceFile
  let lines: string[] = [], blankLine = false
  function add(line: string) {
    if (blankLine) {
      blankLine = false
      if (lines.length && /\S/.test(lines[lines.length - 1])) lines.push("")
    }
    lines.push(line)
  }

  while (pos < text.length) {
    const ch = text.charCodeAt(pos)
    if (ch === 47) { // slash
      const nextCh = text.charCodeAt(pos + 1)
      if (nextCh === 47) {
        let doc = text.charCodeAt(pos + 2) == 47
        let start = pos += doc ? 3 : 2
        while (pos < text.length && !isLineBreak(text.charCodeAt(pos))) pos++
        if (doc) add(text.slice(start, pos))
      } else if (nextCh === 42) { // asterisk
        const doc = text.charCodeAt(pos + 2) == 42, start = pos + (doc ? 3 : 2)
        for (pos = start; pos < text.length; ++pos)
          if (text.charCodeAt(pos) === 42 /* asterisk */ && text.charCodeAt(pos + 1) === 47 /* slash */) break
        if (doc) add(text.slice(start, pos))
        pos += 2
      }
    } else if (isWhiteSpaceLike(ch)) {
      pos++
      if (ch == 10 && text.charCodeAt(pos) == 10) blankLine = true
    } else {
      break
    }
  }
  return stripComment(lines)
}

function stripComment(lines: string[]) {
  for (var head, i = 1; i < lines.length; i++) {
    var line = lines[i], lineHead = line.match(/^[\s\*]*/)![0]
    if (lineHead != line) {
      if (head == null) {
        head = lineHead
      } else {
        var same = 0
        while (same < head.length && head.charCodeAt(same) == lineHead.charCodeAt(same)) ++same
        if (same < head.length) head = head.slice(0, same)
      }
    }
  }
  if (head != null) {
    var startIndent = /^\s*/.exec(lines[0])![0]
    var trailing = /\s*$/.exec(head)![0]
    var extra = trailing.length - startIndent.length
    if (extra > 0) head = head.slice(0, head.length - extra)
  }

  outer: for (var i = 0; i < lines.length; i++) {
    var line = lines[i].replace(/\s+$/, "")
    if (i == 0 && head != null) {
      for (var j = 0; j < head.length; j++) {
        var found = line.indexOf(head.slice(j))
        if (found == 0) {
          lines[i] = line.slice(head.length - j)
          continue outer
        }
      }
    }
    if (head == null || i == 0)
      lines[i] = line.replace(/^[\s\*]*/, "")
    else if (line.length < head.length)
      lines[i] = ""
    else
      lines[i] = line.slice(head.length)
  }

  while (lines.length && !lines[lines.length - 1]) lines.pop()
  while (lines.length && !lines[0]) lines.shift()
  return lines.join("\n")
}

export function gather({filename, items = Object.create(null), basedir}:
                       {filename: string, items?: {[name: string]: any}, basedir?: string}) {
  const configPath = findConfigFile(filename, sys.fileExists)
  const host = createCompilerHost({})
  const options = configPath ? getParsedCommandLineOfConfigFile(configPath, {}, host as any)!.options : {}
  const program = createProgram({rootNames: [filename], options, host})
  const sourceFile = program.getSourceFile(filename)
  if (!sourceFile) throw new Error(`Source file "${filename}" not found`)

  const tc = program.getTypeChecker()
  const exports = tc.getExportsOfModule(tc.getSymbolAtLocation(sourceFile)!)

  // Add all symbols aliased by exports to the set of things that
  // should be considered exported
  const closedExports = exports.slice()
  for (let i = 0; i < closedExports.length; i++) {
    let sym = closedExports[i], alias = (sym.flags & SymbolFlags.Alias) ? tc.getAliasedSymbol(sym) : null
    if (alias && !closedExports.includes(alias)) closedExports.push(alias)
  }

  new Context(tc, closedExports, resolve(basedir || dirname(configPath || filename)), "", []).gatherSymbols(exports, items, "")
  return items
}
