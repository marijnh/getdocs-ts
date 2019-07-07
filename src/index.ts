import {
  getCombinedModifierFlags, findConfigFile, createCompilerHost, getParsedCommandLineOfConfigFile, createProgram, sys,
  getEffectiveConstraintOfTypeParameter,
  getLineAndCharacterOfPosition, isWhiteSpaceLike, isWhiteSpaceSingleLine, isLineBreak,
  isClassLike,
  TypeChecker,
  Symbol, SymbolFlags, ModifierFlags,
  Type, TypeFlags, ObjectType, TypeReference, ObjectFlags, LiteralType, UnionOrIntersectionType, Signature,
  Node, SyntaxKind, TypeParameterDeclaration, UnionOrIntersectionTypeNode,
  Declaration, EnumDeclaration, VariableDeclaration
} from "typescript"

const {resolve, dirname, relative} = require("path")

type BindingKind = "class" | "enum" | "enummember" | "interface" | "variable" | "property" | "method" |
  "typealias" | "typeparam" | "constructor"

type Loc = {file: string, line: number, column: number}

type Binding = {
  kind: BindingKind,
  id: string,
  description?: string,
  loc?: Loc,
  typeParams?: readonly ParamType[],
  exported?: boolean,
  abstract?: boolean,
  readonly?: boolean,
}

type BindingType = {
  type: string,
  typeSource?: string, // missing means this is a built-in type
  typeParamSource?: string,
  properties?: {[name: string]: Item},
  instanceProperties?: {[name: string]: Item},
  typeArgs?: readonly BindingType[],
  params?: readonly ParamType[],
  returns?: BindingType,
  extends?: BindingType,
  implements?: readonly BindingType[],
  construct?: Item
}

type ParamType = BindingType & {
  name: string,
  optional?: boolean,
  default?: string
}

type Item = Binding & BindingType

class Context {
  constructor(readonly tc: TypeChecker,
              readonly exports: readonly Symbol[],
              readonly basedir: string,
              readonly id: string,
              readonly typeParams: {name: string, id: string}[]) {}

  extend(symbol: Symbol | string, sep = "^") {
    let nm = typeof symbol == "string" ? symbol : name(symbol)
    return new Context(this.tc, this.exports, this.basedir, this.id ? this.id + sep + nm : nm, this.typeParams)
  }

  addParams(typeParams: {name: string, id: string}[]) {
    return new Context(this.tc, this.exports, this.basedir, this.id, typeParams.concat(this.typeParams))
  }

  gatherSymbols(symbols: readonly Symbol[], target: {[name: string]: any}, sep = ".") {
    for (const symbol of symbols.slice().sort(compareSymbols)) {
      let item = this.extend(symbol, sep).itemForSymbol(symbol)
      if (item) target[name(symbol)] = item
    }
  }

  itemForSymbol(symbol: Symbol): Item | null {
    if (symbol.flags & SymbolFlags.Alias)
      return this.itemForSymbol(this.tc.getAliasedSymbol(symbol))

    let kind: BindingKind
    if (symbol.flags & SymbolFlags.PropertyOrAccessor) kind = "property"
    else if (symbol.flags & SymbolFlags.Method) kind = "method"
    else if (symbol.flags & SymbolFlags.Enum) kind = "enum"
    else if (symbol.flags & SymbolFlags.EnumMember) kind = "enummember"
    else if (symbol.flags & SymbolFlags.Class) kind = "class"
    else if (symbol.flags & SymbolFlags.Interface) kind = "interface"
    else if (symbol.flags & SymbolFlags.TypeAlias) kind = "typealias"
    else if (symbol.flags & SymbolFlags.Variable) kind = "variable"
    else if (symbol.flags & SymbolFlags.TypeParameter) kind = "typeparam"
    else throw new Error(`Can not determine a kind for symbol ${symbol.escapedName} with flags ${symbol.flags}`)

    let binding: Binding = {kind, id: this.id}, type = this.symbolType(symbol)
    if (maybeDecl(symbol)) this.addSourceData(symbol.declarations, binding)

    let mods = symbol.valueDeclaration ? getCombinedModifierFlags(symbol.valueDeclaration) : 0
    if (mods & ModifierFlags.Abstract) binding.abstract = true
    if ((mods & ModifierFlags.Readonly) ||
        ((symbol.flags & (SymbolFlags.GetAccessor | SymbolFlags.SetAccessor)) == SymbolFlags.GetAccessor))
      binding.readonly = true
    if ((mods & ModifierFlags.Private) || binding.description && /@internal\b/.test(binding.description)) return null

    let params = this.getTypeParams(decl(symbol))
    let cx: Context = this
    if (params) {
      binding.typeParams = params
      cx = cx.addParams(params.map(p => ({name: p.name, id: cx.id})))
    }
    
    return {
      ...binding,
      ...kind == "typealias" ? cx.getTypeInner(type, symbol)
        : kind == "enum" ? this.getEnumType(symbol)
        : cx.getType(type, symbol)
    }
  }

  getEnumType(symbol: Symbol): BindingType {
    let properties: {[name: string]: Item} = {}
    this.gatherSymbols((decl(symbol) as EnumDeclaration).members
                       .map(member => this.tc.getSymbolAtLocation(member.name)!), properties)
    for (let n in properties) {
      properties[n].type = name(symbol)
      properties[n].typeSource = this.nodePath(decl(symbol))
    }
    return {type: "enum", properties}
  }

  getType(type: Type, forSymbol?: Symbol): BindingType {
    if (type.aliasSymbol) {
      let result: BindingType = {type: name(type.aliasSymbol)}
      if (type.aliasTypeArguments) result.typeArgs = type.aliasTypeArguments.map(arg => this.getType(arg))
      return result
    } else {
      return this.getTypeInner(type, forSymbol)
    }
  }

  getTypeInner(type: Type, forSymbol?: Symbol): BindingType {
    if (type.flags & TypeFlags.Any) return {type: "any"}
    if (type.flags & TypeFlags.String) return {type: "string"}
    if (type.flags & TypeFlags.Number) return {type: "number"}
    if (type.flags & TypeFlags.BigInt) return {type: "BigInt"}
    if (type.flags & TypeFlags.ESSymbol) return {type: "Symbol"}
    if (type.flags & TypeFlags.Boolean) return {type: "boolean"}
    if (type.flags & TypeFlags.Undefined) return {type: "undefined"}
    if (type.flags & TypeFlags.Null) return {type: "null"}
    if (type.flags & TypeFlags.Literal) return {type: JSON.stringify((type as LiteralType).value)}
    if (type.flags & TypeFlags.Never) return {type: "never"}

    // FIXME TypeScript seems to reverse the type args to unions. Check whether this is reliable, and re-reverse them if so
    if (type.flags & TypeFlags.UnionOrIntersection) {
      let types = (type as UnionOrIntersectionType).types, decl
      if (forSymbol && (decl = maybeDecl(forSymbol))) {
        let typeNode = (decl as VariableDeclaration).type
        if (typeNode && (typeNode.kind == SyntaxKind.UnionType || typeNode.kind == SyntaxKind.IntersectionType))
          types = (typeNode as UnionOrIntersectionTypeNode).types.map(node => this.tc.getTypeAtLocation(node))
      }
      return {
        type: type.flags & TypeFlags.Union ? "union" : "intersection",
        typeArgs: types.map(type => this.getType(type))
      }
    }

    if (type.flags & TypeFlags.TypeParameter) {
      let nm = name(type.symbol), found = this.typeParams.find(p => p.name == nm)
      if (!found) throw new Error(`Unknown type parameter ${nm}`)
      return {type: nm, typeParamSource: found.id}
    }

    if (type.flags & TypeFlags.Object) {
      let objFlags = (type as ObjectType).objectFlags

      if (!(objFlags & ObjectFlags.Reference)) {
        if (type.symbol.flags & SymbolFlags.Class) return this.getClassType(type as ObjectType)

        let call = type.getCallSignatures(), strIndex = type.getStringIndexType(), numIndex = type.getNumberIndexType()
        if (call.length) return this.addCallSignature(call[0], {type: "Function"})
        if (strIndex) return {type: "Object", typeArgs: [this.extend("0").getType(strIndex)]}
        if (numIndex) return {type: "Array", typeArgs: [this.extend("0").getType(numIndex)]}
        if (objFlags & ObjectFlags.Anonymous) return this.getObjectType(type as ObjectType)
      }

      let result: BindingType = {type: name(type.symbol)}
      let typeSource = this.nodePath(decl(type.symbol))
      if (!isBuiltin(typeSource)) result.typeSource = typeSource
      let typeArgs = (type as TypeReference).typeArguments
      if (typeArgs) {
        let targetParams = (type as TypeReference).target.typeParameters
        let arity = targetParams ? targetParams.length : 0
        if (arity > 0) result.typeArgs = typeArgs.slice(0, arity).map(arg => this.getType(arg))
      }
      return result
    }

    throw new Error(`Unsupported type ${this.tc.typeToString(type)}`)
  }

  getObjectType(type: ObjectType): BindingType {
    let call = type.getCallSignatures(), props = type.getProperties()
    let out: BindingType = {type: type.symbol.flags & SymbolFlags.Interface ? "interface" : "Object"}
    if (call.length) this.addCallSignature(call[0], out)
    if (props.length) this.gatherSymbols(props, out.properties = {})
    return out
  }

  getClassType(type: ObjectType): BindingType {
    let out: BindingType = {type: "class"}
    let classDecl = type.symbol.valueDeclaration
    if (!isClassLike(classDecl)) throw new Error("Class decl isn't class-like")

    let definedProps: string[] = [], definedStatic: string[] = [], ctors: Node[] = []
    for (let member of classDecl.members) {
      let symbol = this.tc.getSymbolAtLocation(member.name || member)!
      if (member.kind == SyntaxKind.Constructor) ctors.push(member)
      else if (getCombinedModifierFlags(member) & ModifierFlags.Static) definedStatic.push(name(symbol))
      else definedProps.push(name(symbol))
    }
    
    for (let ctor of ctors) {
      let signature = type.getConstructSignatures().find(sig => sig.getDeclaration() == ctor)
      if (!signature) continue
      out.construct = {
        ...this.addSourceData([ctor], {kind: "constructor", id: this.id + ".constructor"}),
        type: "Function",
        params: this.extend("constructor", ".").getParams(signature)
      }
      break
    }

    // FIXME I haven't found a less weird way to get the instance type
    let ctorType = type.getConstructSignatures()[0]
    if (ctorType) {
      let protoProps = ctorType.getReturnType().getProperties().filter(prop => definedProps.includes(name(prop)))
      if (protoProps.length) this.gatherSymbols(protoProps, out.instanceProperties = {})
    }

    let props = type.getProperties().filter(prop => definedStatic.includes(name(prop)))
    if (props.length) this.gatherSymbols(props, out.properties = {}, "^")

    if (classDecl.heritageClauses) {
      for (let heritage of classDecl.heritageClauses) {
        let parents = heritage.types.map(node => this.getType(this.tc.getTypeAtLocation(node)))
        if (heritage.token == SyntaxKind.ExtendsKeyword) out.extends = parents[0]
        else out.implements = parents
      }
    }
    return out
  }

  getParams(signature: Signature): ParamType[] {
    return signature.getParameters().map(param => {
      let result = this.extend(param).getType(this.symbolType(param), param) as ParamType
      result.name = name(param)
      let deflt: Node = param.valueDeclaration && (param.valueDeclaration as any).initializer
      if (deflt) result.default = deflt.getSourceFile().text.slice(deflt.pos, deflt.end).trim()
      if (deflt || (param.flags & SymbolFlags.Optional)) result.optional = true
      return result
    })
  }

  getTypeParams(decl: Node): ParamType[] | null {
    let params = (decl as any).typeParameters as TypeParameterDeclaration[]
    return !params ? null : params.map(param => {
      let sym = this.tc.getSymbolAtLocation(param.name)!
      let type: ParamType = {type: "typeparam", name: name(sym)}
      let constraint = getEffectiveConstraintOfTypeParameter(param), cType
      if (constraint && (cType = this.tc.getTypeAtLocation(constraint)))
        type.implements = [this.getType(cType)]
      if (param.default)
        type.default = param.getSourceFile().text.slice(param.default.pos, param.default.end).trim()
      return type
    })
  }

  addCallSignature(signature: Signature, target: BindingType) {
    target.params = this.getParams(signature)
    let ret = signature.getReturnType()
    if (!(ret.flags & TypeFlags.Void)) target.returns = this.extend("returns").getType(ret)
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

  addSourceData(nodes: readonly Node[], target: Binding) {
    let comment = ""
    for (let node of nodes) {
      let c = getComment(node.kind == SyntaxKind.VariableDeclaration ? node.parent.parent : node)
      if (c) comment += (comment ? " " : "") + c
    }
    if (comment) target.description = comment
    const sourceFile = nodes[0].getSourceFile()
    if (!sourceFile) return target // Synthetic node
    let {pos} = nodes[0]
    while (isWhiteSpaceLike(sourceFile.text.charCodeAt(pos))) ++pos
    const {line, character} = getLineAndCharacterOfPosition(sourceFile, pos)
    target.loc = {file: this.nodePath(nodes[0]), line: line + 1, column: character}
    return target
  }
}

function name(symbol: Symbol) { return symbol.escapedName as string }

function maybeDecl(symbol: Symbol): Declaration | undefined {
  return symbol.valueDeclaration || symbol.declarations[0]
}

function decl(symbol: Symbol) {
  let result = maybeDecl(symbol)
  if (!result) throw new Error(`No declaration available for symbole ${symbol.escapedName}`)
  return result
}

function isBuiltin(path: string) {
  return /typescript\/lib\/.*\.es\d+\.d\.ts$/.test(path)
}

function compareSymbols(a: Symbol, b: Symbol) {
  let da = maybeDecl(a), db = maybeDecl(b)
  if (!da) return db ? -1 : 0
  if (!db) return 1
  let fa = da.getSourceFile().fileName, fb = db.getSourceFile().fileName
  return fa == fb ? da.pos - db.pos : fa < fb ? -1 : 1
}

function getComment(node: Node) {
  let {pos} = node
  const sourceFile = node.getSourceFile()
  if (!sourceFile) return "" // Synthetic node
  const {text} = sourceFile
  let result = "", blankLine = false
  while (pos < text.length) {
    const ch = text.charCodeAt(pos)
    if (ch === 47) { // slash
      const nextCh = text.charCodeAt(pos + 1)
      if (nextCh === 47) {
        if (blankLine) {
          blankLine = false
          result = ""
        }
        let start = -1
        pos += 2
        for (; pos < text.length; ++pos) {
          const ch = text.charCodeAt(pos)
          if (start < 0 && !isWhiteSpaceSingleLine(ch)) start = pos
          if (isLineBreak(ch)) break
        }
        if (start > 0) {
          let line = text.substr(start, pos - start)
          result += (result && !/\s$/.test(result) ? " " : "") + line
        }
      } else if (nextCh === 42) { // asterisk
        if (blankLine) {
          blankLine = false
          result = ""
        }
        const start = pos + 2
        for (pos = start; pos < text.length; ++pos)
          if (text.charCodeAt(pos) === 42 /* asterisk */ && text.charCodeAt(pos + 1) === 47 /* slash */) break
        result += text.substr(start, pos - start)
        pos += 2
      }
    } else if (isWhiteSpaceLike(ch)) {
      pos++
      if (ch == 10 && text.charCodeAt(pos) == 10) blankLine = true
    } else {
      break
    }
  }
  return result
}

export function gather({filename, items = Object.create(null)}: {filename: string, items?: {[name: string]: any}}) {
  const configPath = findConfigFile(filename, sys.fileExists)
  const host = createCompilerHost({})
  const options = configPath ? getParsedCommandLineOfConfigFile(configPath, {}, host as any)!.options : {}
  const program = createProgram({rootNames: [filename], options, host})

  const tc = program.getTypeChecker()
  const exports = tc.getExportsOfModule(tc.getSymbolAtLocation(program.getSourceFile(filename)!)!)
  const basedir = resolve(dirname(configPath || filename))
  const module = new Context(tc, exports, basedir, "", [])
  module.gatherSymbols(exports, items, "")
  
  return items
}
