const assert = require("assert")
const path = require("path")
const ts = require("typescript")

class Context {
  constructor(path, thisContext = null, joiner = '.') {
    this.path = path
    this.thisContext = thisContext
    this.joiner = joiner
  }

  add(elem, setThis = false, joiner = '.') {
    return new Context(
      elem ? (this.path ? `${this.path}${this.joiner}${elem}` : elem) : this.path,
      setThis ? elem : this.thisContext,
      joiner
    )
  }
}

class Gatherer {
  getLoc(node) {
    let {pos} = node
    const sourceFile = node.getSourceFile()
    if (!sourceFile) return // Synthetic node
    while (ts.isWhiteSpaceLike(sourceFile.text.charCodeAt(pos))) ++pos
    const {line, character} = ts.computeLineAndCharacterOfPosition(sourceFile.getLineStarts(), pos)
    return { file: sourceFile.originalFileName, line: line + 1, column: character }
  }

  getComments(node) {
    let {pos} = node
    const sourceFile = node.getSourceFile()
    if (!sourceFile) return '' // Synthetic node
    const {text} = sourceFile
    let result = '', blankLine = false
    while (pos < text.length) {
      const ch = text.charCodeAt(pos)
      if (ch === 47) { // slash
        const nextCh = text.charCodeAt(pos + 1)
        if (nextCh === 47) {
          if (blankLine) {
            blankLine = false
            result = ""
          }
          let start = null
          pos += 2
          for (; pos < text.length; ++pos) {
            const ch = text.charCodeAt(pos)
            if (start === null && !ts.isWhiteSpaceSingleLine(ch)) start = pos
            if (ts.isLineBreak(ch)) break
          }
          let line = text.substr(start, pos - start)
          result += (result && !/\s$/.test(result) ? " " : "") + line
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
      } else if (ts.isWhiteSpaceLike(ch)) {
        pos++
        if (ch == 10 && text.charCodeAt(pos) == 10) blankLine = true
      } else {
        break
      }
    }
    return result

    // let result = ''
    // This doesn't read `constructor(/* @internal */ readonly config: Configuration,`
    // ts.forEachLeadingCommentRange(text, pos, (start, end) => {
    //  let text = text.substr(start, end - start)
    //  text = text.replace(/^\/\/\s*/, "")
    //  result += text
    // })
    // return result
  }

  getText(node) {
    const {text} = node.getSourceFile()
    return text.slice(node.pos, node.end).trim()
  }

  // FIXME: This is so bad
  mapType(type, context, register = true) {
    if (type.flags == ts.TypeFlags.Union) {
      return {type: "union", typeParams: type.types.map(t => this.mapType(t, context, register))}
    } else if (type.flags == ts.TypeFlags.Object) {
      if (!(type.objectFlags & ts.ObjectFlags.Reference)) {
        const signature = type.getCallSignatures()[0]
        if (signature) {
          // Resolve instantiated type parameters
          // This breaks getLoc and getComments because it returns synthesized nodes
          const decl = this.typeChecker.signatureToSignatureDeclaration(signature)
          const returns = this.takeUnnamed(decl.type, new Context(context.path, context.thisContext, '^').add("returns"))
          let result = {
            type: "Function",
            params: this.handleNodes(decl.parameters, context, [])
          }
          if (returns.type != "void") result.returns = returns
          return result
        }
        return {
          type: "Object",
          properties: this.handleNodes(type.properties.map(t => t.valueDeclaration), context)
        }
      }
    }
    if (register) this._registerUsageType(type)
    const name = type.intrinsicName || (type.aliasSymbol && type.aliasSymbol.escapedName) || (type.symbol && type.symbol.escapedName)
    return {type: name ? this.inlining[name] || name : JSON.stringify(type.value)}
  }

  _typeArguments(node, context, ret) {
    if (node.typeArguments) ret.typeParams = this.handleNodes(node.typeArguments, context, [])
  }
  _withTypeParameters(node, context, fn) {
    if (node.typeParameters) {
      const typeParams = this.handleNodes(node.typeParameters, context, [])
      // FIXME: The substring matching is necessary because of default values
      this._typeParams.push(typeParams.map(v => v.type.match(/^\w+/)[0]))
      const ret = fn()
      ret.typeParams = typeParams
      this._typeParams.pop()
      return ret
    }
    return fn()
  }
  _isTypeParameter(type) {
    for (const params of this._typeParams) {
      for (const param of params) {
        if (param === type) return true
      }
    }
    return false
  }

  _simple(t) { return [null, {type: t}] }

  NumberKeyword() { return this._simple("number") }
  AnyKeyword() { return this._simple("any") }
  BooleanKeyword() { return this._simple("bool") }
  StringKeyword() { return this._simple("string") }
  NullKeyword() { return this._simple("null") } // FIXME: Is this correct?
  // This is handled (i. e. removed) by callers
  VoidKeyword() { return this._simple("void") }
  UndefinedKeyword() { return this._simple("undefined") }
  ThisType(node, context) { return this._simple(context.thisContext) }
  IndexSignature(node, context) {
    // FIXME: This is pretty horrible
    return [`[${node.parameters[0].name.escapedText}: ${this.takeUnnamed(node.parameters[0].type, context).type}]`, this.takeUnnamed(node.type, context)]
  }
  IndexedAccessType(node, context) {
    // FIXME: bad
    return [null, {type: this.getText(node)}]
  }
  ParenthesizedType(node, context) {
    return this.callHandler(node.type, context)
  }
  MappedType(node, context) {
    // FIXME: maybe bad
    const properties = {}
    properties[`[${this.takeUnnamed(node.typeParameter, context).type}]`] = this.takeUnnamed(node.type, context)
    return [null, {type: "Object", properties}]
  }
  TypeAliasDeclaration(node, context) {
    const name = node.symbol.escapedName
    context = context.add(name)
    const value = this._withTypeParameters(node, context, () => this.takeUnnamed(node.type, context))
    return [name, {type: "type", value}]
  }
  TypeLiteral(node, context) {
    return [null, {type: "Object", properties: this.handleNodes(node.members, context)}]
  }
  PropertyAssignment(node, context) {
    const name = node.symbol.escapedName
    context = context.add(name)
    return [name, this.mapType(this.typeChecker.getTypeAtLocation(node), context)]
  }
  ShorthandPropertyAssignment(node, context) {
    return this.PropertyAssignment(node, context)
/*
    const name = node.symbol.escapedName
    context = context.add(name)
    return [name, this.mapType(
      this.typeChecker.getTypeOfSymbolAtLocation(this.typeChecker.getShorthandAssignmentValueSymbol(node), node)
      , context)]
*/
  }
  FunctionType(node, context) {
    return this._Function(node, null, context)
  }
  EnumDeclaration(node, context) {
    const name = node.symbol.escapedName
    context = context.add(name)
    return [name, { type: "", properties: this.handleNodes(node.members, context) }]
  }
  EnumMember(node, context) {
    const name = node.symbol.escapedName
    return [name, {type: "", description: " " /* Make sure that builddoc renders them as separate items */ }]
  }
  UnionType(node, context) {
    return [null, {type: "union", typeParams: this.handleNodes(node.types, context, [])}]
  }

  _registerUsageType(type) {
    if (type.aliasSymbol) this._registerUsageSymbol(type.aliasSymbol)
    else if (type.symbol) this._registerUsageSymbol(type.symbol)
    // Only triggers for built-ins so far
    //else console.warn("No symbol found for " + type.intrinsicName || (type.aliasSymbol && type.aliasSymbol.escapedName) || (type.symbol && type.symbol.escapedName) || JSON.stringify(type.value))
  }

  _registerUsageSymbol(symbol) {
    const name = symbol.escapedName
    let source_path = null
    if (symbol.parent && symbol.parent.flags & ts.SymbolFlags.ValueModule) {
      source_path = symbol.parent.valueDeclaration.fileName
    } else if (symbol.declarations.length) {
      source_path = symbol.declarations[0].getSourceFile().fileName
    } else console.warn(symbol)
    if (source_path && path.resolve(source_path).startsWith(this.basedir)) {
      if (!this.exportedSymbols.includes(name) && !this.inlining[name]) {
        console.warn(`Internal symbol ${name} used in public interface, but not exported, trying to inline …`)
        // FIXME: Context?
        // FIXME: mapType doesn't really inline
        this.inlining[name] = this.mapType(this.typeChecker.getDeclaredTypeOfSymbol(symbol), new Context(""), false)
        source_path = false
      } else return
    }
    if (Object.prototype.hasOwnProperty.call(this.usages, name) && this.usages[name] !== source_path) console.warn(`Conflicting usage for ${name}: ${this.usages[name]} vs ${path}`)

    this.usages[name] = source_path
  }

  TypeReference(node, context) {
    let ret = {type: node.typeName.name || node.typeName.escapedText}
    if (this._isTypeParameter(ret.type)) {
      ret.typeParamUsage = true
    } else {
      const name = ret.type
      if (node.typeName.symbol) this._registerUsageSymbol(node.typeName.symbol) // For synthetic nodes
      else {
        const type = this.typeChecker.getTypeAtLocation(node)
        this._registerUsageType(type)
        // This is completely wrong for a parametrized type alias
        if (type.aliasSymbol) ret.type = type.aliasSymbol.escapedName
      }
      if (this.inlining[name]) ret = this.inlining[name]
    }
    this._typeArguments(node, context, ret)
    return [null, ret]
  }
  ArrayType(node, context) {
    return [null, {type: "Array", typeParams: [this.takeUnnamed(node.elementType, context)]}]
  }
  LiteralType(node, context) {
    return [null, {type: ts.SyntaxKind[node.literal.kind] === 'StringLiteral' ? JSON.stringify(node.literal.text) : node.literal.text || this.getText(node)}]
  }

  ClassDeclaration(node, context) {
    const name = node.symbol.escapedName
    const staticContext = context.add(name, true, '^')
    context = context.add(name, true)
    let properties, staticProperties, constructor
    const isPrivate = node => ts.hasModifier(node, ts.ModifierFlags.Private)
    const ret = this._withTypeParameters(node, context, () => {
      for (const prop of node.members) {
        if (ts.SyntaxKind[prop.kind] == "Constructor") {
          this.constructorProps.push([])
          const privateConstructor = isPrivate(prop) || ts.isInternalDeclaration(prop, prop.getSourceFile())
          const usages = this.usages
          if (privateConstructor) this.usages = {}
          constructor = this.callHandler(prop, context)[1]
          if (privateConstructor) {
            this.usages = usages
            constructor = undefined
          } else {
            let comment = this.getComments(prop)
            if (comment) constructor.description = comment
            constructor.id = context.path + '.constructor'
            delete constructor.returns
          }
          const constructorProps = this.constructorProps.pop().filter(prop => !isPrivate(prop))
          if (constructorProps.length) properties = this.handleNodes(constructorProps, context, properties)
        } else if (!isPrivate(prop)) {
          const isStatic = ts.hasModifier(prop, ts.ModifierFlags.Static)
          let [props, ctx] = isStatic ? [staticProperties, staticContext] : [properties, context]
          const addProp = (name, v) => {
            props = props || Object.create(null)
            if (!props[name]) props[name] = v
            else {
              if (props[name].type !== v.type) console.warn(`Getter and setter types mismatch for ${name}: ${props[name].type} vs ${v.type}`)
              props[name].description = props[name].description || v.description
            }
          }
          if (ts.SyntaxKind[prop.kind] == "GetAccessor") {
            const ret = this.callHandler(prop, ctx)
            if (!ret) continue
            const [name, v] = ret
            v.readonly = true
            addProp(name, v)
          } else if (ts.SyntaxKind[prop.kind] == "SetAccessor") {
            const ret = this.callHandler(prop, ctx)
            if (!ret) continue
            const [name, v] = ret
            addProp(name, v)
            delete props[name].readonly
          } else {
            props = this.handleNode(prop, ctx, props)
          }
          if (isStatic) staticProperties = props
          else properties = props
        }
      }
      const ret = {type: "class"}
      if (constructor) ret.constructor = constructor
      if (properties) ret.properties = properties
      if (staticProperties) ret.staticProperties = staticProperties
      if (ts.hasModifier(node, ts.ModifierFlags.Abstract)) ret.abstract = true
      if (node.heritageClauses) {
        for (const heritageClause of node.heritageClauses) {
          ret[heritageClause.token == ts.SyntaxKind.ExtendsKeyword ? "extends" : "implements"] = this.takeUnnamed(heritageClause, context)
        }
      }
      return ret
    })
    return [name, ret]
  }
  TypeParameter(node, context) {
    // FIXME: This could be smarter {name, constraint, default}
    return [null, {type: this.getText(node)}]
  }
  PropertyDeclaration(node, context) {
    const name = node.symbol.escapedName
    let data
    if (node.type) {
      data = this.takeUnnamed(node.type, context.add(name))
      delete data.loc
    } else {
      data = this.mapType(this.typeChecker.getTypeAtLocation(node), context)
    }
    if (ts.hasModifier(node, ts.ModifierFlags.Abstract)) data.abstract = true
    if (ts.hasModifier(node, ts.ModifierFlags.Readonly)) data.readonly = true
    return [name, data]
  }
  MethodDeclaration(node, context) {
    const [name, ret] = this._Function(node, node.symbol.escapedName, context)
    if (ts.hasModifier(node, ts.ModifierFlags.Abstract)) ret.abstract = true
    return [name, ret]
  }
  GetAccessor(node, context) {
    const [name, v] = this.MethodDeclaration(node, context)
    const {returns: {loc: _, ...type}, params: _2, ...value} = v
    return [name, {...value, ...type}]
  }
  SetAccessor(node, context) {
    const [name, v] = this.MethodDeclaration(node, context)
    const {params: [{loc:_, ...type}], ...value} = v
    return [name, {...value, ...type}]
  }
  Constructor(node, context) {
    const [name, ret] = this._Function(node, "constructor", context)
    if (ts.hasModifier(node, ts.ModifierFlags.Abstract)) ret.abstract = true
    return [name, ret]
  }
  InterfaceDeclaration(node, context) {
    const name = node.symbol.escapedName
    context = context.add(name, true)
    assert(!node.heritageClauses || node.heritageClauses.length < 2)
    const ret = this._withTypeParameters(node, context, () => {
      const ret = {type: "interface", properties: this.handleNodes(node.members, context)}
      if (node.heritageClauses) ret.extends = this.takeUnnamed(node.heritageClauses[0], context)
      return ret
    })
    return [name, ret]
  }
  _Function(node, id, context) {
    context = context.add(id, false, '^')
    const ret = this._withTypeParameters(node, context, () => {
      const ret = {type: "Function"}
      const returnsContext = context.add('returns')
      if (node.type) {
        ret.returns = this.takeUnnamed(node.type, returnsContext)
      } else {
        const signature = this.typeChecker.getSignatureFromDeclaration( node )
        const returnType = this.typeChecker.getReturnTypeOfSignature( signature )
        ret.returns = this.mapType(returnType, returnsContext)
      }
      if (ret.returns.type == "void") {
        delete ret.returns
      } else {
        ret.returns.id = returnsContext.path
      }
      ret.params = this.handleNodes(node.parameters, context, [])
      return ret
    })

    return [id, ret]
  }
  FunctionDeclaration(node, context) {
    return this._Function(node, node.symbol.escapedName, context)
  }
  Parameter(node, context) {
    const name = node.name.kind == ts.SyntaxKind.Identifier ? node.name.escapedText : null
    let value
    if (node.type) {
      value = this.takeUnnamed(node.type, name ? context.add(name) : context)
      delete value.loc
    } else {
      value = this.mapType(this.typeChecker.getTypeAtLocation(node), context)
    }
    if (node._TSParameterAsProperty) {
      if (ts.hasModifier(node, ts.ModifierFlags.Readonly)) value.readonly = true
    } else {
      if (node.symbol && node.symbol.parent) {
        node._TSParameterAsProperty = true // FIXME hacky
        this.constructorProps[this.constructorProps.length - 1].push(node)
      }
      if (node.questionToken) value.optional = true
      if (node.dotDotDotToken) value.rest = true
      if (node.initializer) {
        value.default = this.getText(node.initializer)
        value.optional = true
      }
    }
    return [name, value]
  }
  MethodSignature(node, context) {
    return this._Function(node, node.symbol.escapedName, context)
  }
  PropertySignature(node, context) {
    const name = node.name.escapedText
    const ret = this.takeUnnamed(node.type, context.add(name))
    if (node.questionToken) ret.optional = true
    delete ret.loc
    return [name, ret]
  }
  Identifier(node, context) {
    const type = this.typeChecker.getTypeAtLocation(node)
    this._registerUsageType(type)
    return [null, this.inlining[node.escapedText] || {type: node.escapedText}]
  }
  HeritageClause(node, context) {
    assert(node.types.length === 1)
    return this.callHandler(node.types[0], context)
  }
  ExpressionWithTypeArguments(node, context) {
    const ret = this.takeUnnamed(node.expression, context)
    this._typeArguments(node, context, ret)
    return [null, ret]
  }
  VariableDeclaration(node, context) {
    const name = node.symbol.escapedName
    context = context.add(name)
    let ret
    if (node.type) {
      ret = this.takeUnnamed(node.type, context)
      delete ret.loc
    } else {
      ret = this.mapType(this.typeChecker.getTypeAtLocation(node), context)
    }
    return [name, ret]
  }
  ExportSpecifier(node, context) {
    return this.callHandler(this.typeChecker.getExportSpecifierLocalTargetSymbol(node).declarations[0], context)
  }

  constructor(typeChecker) {
    this.typeChecker = typeChecker
    this.constructorProps = []
    this.usages = Object.create(null)
    this.exportedSymbols = []
    this.inlining = Object.create(null)
    this._typeParams = []
  }

  callHandler(node, context) {
    if (!node.kind || !this[ts.SyntaxKind[node.kind]]) console.warn(ts.SyntaxKind[node.kind], context, node)

    let internal = ts.isInternalDeclaration(node, node.getSourceFile())
    if (internal && node.kind !== ts.SyntaxKind.Parameter && node.kind !== ts.SyntaxKind.Constructor) return
    const [name, value] = this[ts.SyntaxKind[node.kind]](node, context)
    let comment = this.getComments(ts.SyntaxKind[node.kind] == "VariableDeclaration" ? node.parent.parent : node)

    // In this case, @internal only refers to the field, not the constructor parameter
    if (internal && node.kind === ts.SyntaxKind.Parameter && node.symbol.parent) {
      this.constructorProps[this.constructorProps.length - 1].pop()
      comment = comment.replace(/\s*@internal\s*/, '')
    }
    if (comment) value.description = comment
    if (!value.loc) {
      const loc = this.getLoc(node)
      if (loc) value.loc = loc
    }
    if (name) value.id = context.add(name).path

    return [name, value]
  }

  handleNode(node, context, result) {
    const res = this.callHandler(node, context)
    if (!res) return result
    const [name, value] = res
    if (Array.isArray(result)) {
      if (name) value.name = name
      result.push(value)
    } else {
      if (!result) result = Object.create(null)
      result[name] = value
    }
    return result
  }

  handleNodes(nodes, context, result = Object.create(null)) {
    nodes.forEach(n => this.handleNode(n, context, result))
    return result
  }

  takeUnnamed(node, context) {
    const [name, t] = this.callHandler(node, context)
    assert.strictEqual(name, null)
    return t
  }

  gatherExports(sourceFile, items) {
    const context = new Context("")
    const exports = this.typeChecker.getExportsOfModule(sourceFile.symbol)
    this.exportedSymbols = exports.map(s => s.escapedName)
    this.basedir = path.resolve(path.dirname(sourceFile.originalFileName))
    for (const exportSymbol of exports) {
      if (exportSymbol.declarations.length !== 1) console.warn(exportSymbol)
      items[exportSymbol.escapedName] = {exported: true, ...this.callHandler(exportSymbol.declarations[0], context)[1]}
    }
    return items
  }
}

function getTSProgram(fileName) {
  const configPath = ts.findConfigFile(fileName, ts.sys.fileExists, "tsconfig.json")
  const host = ts.createCompilerHost({})
  const {options} = configPath ? ts.getParsedCommandLineOfConfigFile(configPath, undefined, host) : {}
  return ts.createProgram({ rootNames: [fileName], options, host })
}

exports.gather = ({filename, items = Object.create(null)}) => {
  const program = getTSProgram(filename)
  const gatherer = new Gatherer(program.getTypeChecker())
  const sourceFile = program.getSourceFile(filename)
  gatherer.gatherExports(sourceFile, items)
  return {exports: items, usages: gatherer.usages}
}
