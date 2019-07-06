import {
  getCombinedModifierFlags, findConfigFile, createCompilerHost, getParsedCommandLineOfConfigFile, createProgram, sys,
  getLineAndCharacterOfPosition, isWhiteSpaceLike, isWhiteSpaceSingleLine, isLineBreak,
  TypeChecker,
  Symbol, SymbolFlags, ModifierFlags,
  Type, TypeFlags, ObjectType, ObjectFlags, UnionOrIntersectionType, InterfaceType, Signature,
  Node, TypeAliasDeclaration
} from "typescript"

const {resolve, dirname, relative} = require("path")

type BindingKind = "class" | "enum" | "enummember" | "interface" | "variable" | "property" | "method" |
  "typealias" | "typeparam" | "constructor" | "parameter"

type Loc = {file: string, line: number, column: number}

type Binding = {
  kind: BindingKind,
  id: string,
  description?: string,
  loc?: Loc,
  typeParams?: readonly Item[],
  exported?: boolean,
  abstract?: boolean,
  readonly?: boolean,
}

type BindingType = {
  type: string,
  typeSource?: string, // missing means this is a built-in type
  typeParamID?: string,
  properties?: {[name: string]: Item},
  instanceProperties?: {[name: string]: Item},
  typeArgs?: readonly BindingType[],
  params?: readonly (BindingType & {name: string})[],
  returns?: BindingType,
  construct?: Item
}

type Item = Binding & BindingType

class Module {
  constructor(readonly tc: TypeChecker,
              readonly exports: readonly Symbol[],
              readonly basedir: string) {}

  gatherSymbols(symbols: readonly Symbol[], target: {[name: string]: any}, parentID: string) {
    for (const symbol of symbols) {
      let item = this.itemForSymbol(symbol, parentID)
      if (item) target[name(symbol)] = item
    }
  }

  itemForSymbol(symbol: Symbol, parentID: string): Item | null {
    let id = parentID + name(symbol), kind: BindingKind
    if (symbol.flags & SymbolFlags.PropertyOrAccessor) kind = "property"
    else if (symbol.flags & SymbolFlags.Method) kind = "method"
    else if (symbol.flags & SymbolFlags.EnumMember) kind = "enummember"
    else if (symbol.flags & SymbolFlags.Class) kind = "class"
    else if (symbol.flags & SymbolFlags.Interface) kind = "interface"
    else if (symbol.flags & SymbolFlags.Enum) kind = "enum"
    else if (symbol.flags & SymbolFlags.TypeAlias) kind = "typealias"
    else if (symbol.flags & SymbolFlags.Variable) kind = "variable"
    else if (symbol.flags & SymbolFlags.TypeParameter) kind = "typeparam"
    else throw new Error(`Can not determine a kind for symbol ${symbol.escapedName} with flags ${symbol.flags}`)

    let binding: Binding = {kind, id}, type = this.symbolType(symbol)
    if (hasDecl(symbol)) this.addSourceData(decl(symbol), binding)
    if (kind == "class" || kind == "interface") {
      let params = (type as InterfaceType).typeParameters
      if (params) binding.typeParams = params.map(tp => ({kind: "typeparam", id: id + "^" + name(tp.symbol), ...this.getType(tp, id)}))
    } else if (kind == "typealias") {
      let params = (decl(symbol) as TypeAliasDeclaration).typeParameters
      if (params) binding.typeParams = params
        .map(tpDecl => this.itemForSymbol(this.tc.getSymbolAtLocation(tpDecl)!, id + "^"))
        .filter(v => !!v) as Item[]
    } // FIXME check for call signatures with args, clean up handling of type params

    let mods = symbol.valueDeclaration ? getCombinedModifierFlags(symbol.valueDeclaration) : 0
    if (mods & ModifierFlags.Abstract) binding.abstract = true
    if (mods & ModifierFlags.Readonly) binding.readonly = true
    if ((mods & ModifierFlags.Private) || binding.description && /@internal\b/.test(binding.description)) return null
    
    return {...binding, ...this.getType(type, id, !["property", "method", "variable"].includes(kind))}
  }

  getType(type: Type, id: string, describe = false): BindingType {
    if (type.flags & TypeFlags.Any) return {type: "any"}
    if (type.flags & TypeFlags.String) return {type: "string"}
    if (type.flags & TypeFlags.Number) return {type: "number"}
    if (type.flags & TypeFlags.BigInt) return {type: "BigInt"}
    if (type.flags & TypeFlags.ESSymbol) return {type: "Symbol"}
    if (type.flags & TypeFlags.Boolean) return {type: "boolean"}
    if (type.flags & TypeFlags.Undefined) return {type: "undefined"}
    if (type.flags & TypeFlags.Null) return {type: "null"}
    if (type.flags & TypeFlags.Literal) return {type: name(type.symbol)}
    if (type.flags & TypeFlags.Never) return {type: "never"}

    // FIXME enums, aliases

    if (type.flags & TypeFlags.UnionOrIntersection) return {
      type: type.flags & TypeFlags.Union ? "union" : "intersection",
      typeArgs: (type as UnionOrIntersectionType).types.map(type => this.getType(type, id))
    }

    if (type.flags & TypeFlags.TypeParameter) return {
      type: name(type.symbol),
      typeSource: this.typeSource(type),
      // FIXME point at ID from context
    }

    if (type.flags & TypeFlags.Object) {
      if ((describe || (type as ObjectType).objectFlags & ObjectFlags.Anonymous) &&
          ((type.symbol.flags & SymbolFlags.Class) || type.getProperties().length))
        return this.getTypeDesc(type as ObjectType, id)
      let call = type.getCallSignatures(), strIndex = type.getStringIndexType(), numIndex = type.getNumberIndexType()
      if (call.length) return this.addCallSignature(call[0], {type: "Function"}, id)
      if (strIndex) return {type: "Object", typeArgs: [this.getType(strIndex, id + "^0")]}
      if (numIndex) return {type: "Array", typeArgs: [this.getType(numIndex, id + "^0")]}
      return {type: name(type.symbol), typeSource: this.typeSource(type)} // FIXME type args
    }

    throw new Error(`Unsupported type ${this.tc.typeToString(type)}`)
  }

  getTypeDesc(type: ObjectType, id: string): BindingType {
    let call = type.getCallSignatures(), props = type.getProperties()
    // FIXME array/function types
    // FIXME figure out how type params vs type args are represented
    if (type.symbol.flags & SymbolFlags.Class) {
      let out: BindingType = {type: "class"}
      let ctor = type.getConstructSignatures(), ctorNode
      if (ctor.length && (ctorNode = ctor[0].getDeclaration())) {
        out.construct = {...this.addSourceData(ctorNode, {kind: "constructor", id: id + "^constructor"}),
                         type: "Function",
                         params: this.getParams(ctor[0], id)}
      }
      props = props.filter(prop => prop.escapedName != "prototype")

      // FIXME I haven't found a less weird way to get the instance type
      let instanceType = ctor.length && ctor[0].getReturnType()
      if (instanceType) {
        let protoProps = instanceType.getProperties()
        if (protoProps.length) this.gatherSymbols(protoProps, out.instanceProperties = {}, id + ".")
      }
      if (props.length) this.gatherSymbols(props, out.properties = {}, id + "^")
      return out
    }

    let out: BindingType = {type: type.symbol.flags & SymbolFlags.Interface ? "interface" : "Object"}
    if (call.length) this.addCallSignature(call[0], out, id)
    if (props.length) this.gatherSymbols(props, out.properties = {}, id + ".")
    return out
  }

  typeSource(type: Type) {
    return relative(process.cwd(), decl(type.symbol).getSourceFile().fileName)
  }

  getParams(signature: Signature, id: string): (BindingType & {name: string})[] {
    return signature.getParameters().map(param => {
      return {name: name(param), ...this.getType(this.symbolType(param), id + "^" + param.escapedName)}
    })
  }

  addCallSignature(signature: Signature, target: BindingType, id: string) {
    target.params = this.getParams(signature, id)
    let ret = signature.getReturnType()
    if (!(ret.flags & TypeFlags.Void)) target.returns = this.getType(ret, id)
    return target
  }

  symbolType(symbol: Symbol) {
    let type = this.tc.getTypeOfSymbolAtLocation(symbol, decl(symbol))
    // FIXME this is weird and silly but for interface declarations TS gives a symbol type of any
    if (!type.symbol || type.flags & TypeFlags.Any) type = this.tc.getDeclaredTypeOfSymbol(symbol)
    return type
  }

  addSourceData(node: Node, target: Binding) {
    let comment = getComment(node)
    if (comment) target.description = comment
    // FIXME add description comments
    const sourceFile = node.getSourceFile()
    if (!sourceFile) return target // Synthetic node
    let {pos} = node
    while (isWhiteSpaceLike(sourceFile.text.charCodeAt(pos))) ++pos
    const {line, character} = getLineAndCharacterOfPosition(sourceFile, pos)
    target.loc = {file: relative(process.cwd(), sourceFile.fileName), line: line + 1, column: character}
    return target
  }
}

function name(symbol: Symbol) { return symbol.escapedName as string }

function decl(symbol: Symbol) {
  let result = symbol.valueDeclaration || symbol.declarations[0]
  if (!result) throw new Error(`No declaration available for symbole ${symbol.escapedName}`)
  return result
}

function hasDecl(symbol: Symbol) {
  return !!symbol.valueDeclaration || symbol.declarations.length > 0
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
  const module = new Module(tc, exports, basedir)
  module.gatherSymbols(exports, items, "")
  
  return items
}
