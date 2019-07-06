"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const typescript_1 = require("typescript");
const { resolve, dirname, relative } = require("path");
class Module {
    constructor(tc, exports, basedir) {
        this.tc = tc;
        this.exports = exports;
        this.basedir = basedir;
    }
    gatherSymbols(symbols, target, parentID) {
        for (const symbol of symbols) {
            let item = this.itemForSymbol(symbol, parentID);
            if (item)
                target[name(symbol)] = item;
        }
    }
    itemForSymbol(symbol, parentID) {
        let id = parentID + name(symbol), kind;
        if (symbol.flags & typescript_1.SymbolFlags.PropertyOrAccessor)
            kind = "property";
        else if (symbol.flags & typescript_1.SymbolFlags.Method)
            kind = "method";
        else if (symbol.flags & typescript_1.SymbolFlags.EnumMember)
            kind = "enummember";
        else if (symbol.flags & typescript_1.SymbolFlags.Class)
            kind = "class";
        else if (symbol.flags & typescript_1.SymbolFlags.Interface)
            kind = "interface";
        else if (symbol.flags & typescript_1.SymbolFlags.Enum)
            kind = "enum";
        else if (symbol.flags & typescript_1.SymbolFlags.TypeAlias)
            kind = "typealias";
        else if (symbol.flags & typescript_1.SymbolFlags.Variable)
            kind = "variable";
        else if (symbol.flags & typescript_1.SymbolFlags.TypeParameter)
            kind = "typeparam";
        else
            throw new Error(`Can not determine a kind for symbol ${symbol.escapedName} with flags ${symbol.flags}`);
        let binding = { kind, id }, type = this.symbolType(symbol);
        if (hasDecl(symbol))
            this.addSourceData(decl(symbol), binding);
        if (kind == "class" || kind == "interface") {
            let params = type.typeParameters;
            if (params)
                binding.typeParams = params.map(tp => (Object.assign({ kind: "typeparam", id: id + "^" + name(tp.symbol) }, this.getType(tp, id))));
        }
        else if (kind == "typealias") {
            let params = decl(symbol).typeParameters;
            if (params)
                binding.typeParams = params
                    .map(tpDecl => this.itemForSymbol(this.tc.getSymbolAtLocation(tpDecl), id + "^"))
                    .filter(v => !!v);
        } // FIXME check for call signatures with args, clean up handling of type params
        let mods = symbol.valueDeclaration ? typescript_1.getCombinedModifierFlags(symbol.valueDeclaration) : 0;
        if (mods & typescript_1.ModifierFlags.Abstract)
            binding.abstract = true;
        if (mods & typescript_1.ModifierFlags.Readonly)
            binding.readonly = true;
        if ((mods & typescript_1.ModifierFlags.Private) || binding.description && /@internal\b/.test(binding.description))
            return null;
        return Object.assign({}, binding, this.getType(type, id, !["property", "method", "variable"].includes(kind)));
    }
    getType(type, id, describe = false) {
        if (type.flags & typescript_1.TypeFlags.Any)
            return { type: "any" };
        if (type.flags & typescript_1.TypeFlags.String)
            return { type: "string" };
        if (type.flags & typescript_1.TypeFlags.Number)
            return { type: "number" };
        if (type.flags & typescript_1.TypeFlags.BigInt)
            return { type: "BigInt" };
        if (type.flags & typescript_1.TypeFlags.ESSymbol)
            return { type: "Symbol" };
        if (type.flags & typescript_1.TypeFlags.Boolean)
            return { type: "boolean" };
        if (type.flags & typescript_1.TypeFlags.Undefined)
            return { type: "undefined" };
        if (type.flags & typescript_1.TypeFlags.Null)
            return { type: "null" };
        if (type.flags & typescript_1.TypeFlags.Literal)
            return { type: name(type.symbol) };
        if (type.flags & typescript_1.TypeFlags.Never)
            return { type: "never" };
        // FIXME enums, aliases
        if (type.flags & typescript_1.TypeFlags.UnionOrIntersection)
            return {
                type: type.flags & typescript_1.TypeFlags.Union ? "union" : "intersection",
                typeArgs: type.types.map(type => this.getType(type, id))
            };
        if (type.flags & typescript_1.TypeFlags.TypeParameter)
            return {
                type: name(type.symbol),
                typeSource: this.typeSource(type),
            };
        if (type.flags & typescript_1.TypeFlags.Object) {
            if ((describe || type.objectFlags & typescript_1.ObjectFlags.Anonymous) &&
                ((type.symbol.flags & typescript_1.SymbolFlags.Class) || type.getProperties().length))
                return this.getTypeDesc(type, id);
            let call = type.getCallSignatures(), strIndex = type.getStringIndexType(), numIndex = type.getNumberIndexType();
            if (call.length)
                return this.addCallSignature(call[0], { type: "Function" }, id);
            if (strIndex)
                return { type: "Object", typeArgs: [this.getType(strIndex, id + "^0")] };
            if (numIndex)
                return { type: "Array", typeArgs: [this.getType(numIndex, id + "^0")] };
            return { type: name(type.symbol), typeSource: this.typeSource(type) }; // FIXME type args
        }
        throw new Error(`Unsupported type ${this.tc.typeToString(type)}`);
    }
    getTypeDesc(type, id) {
        let call = type.getCallSignatures(), props = type.getProperties();
        // FIXME array/function types
        // FIXME figure out how type params vs type args are represented
        if (type.symbol.flags & typescript_1.SymbolFlags.Class) {
            console.log("it's a class", props.length, this.tc.typeToString(type));
            let out = { type: "class" };
            let ctor = type.getConstructSignatures(), ctorNode;
            if (ctor.length && (ctorNode = ctor[0].getDeclaration())) {
                out.construct = Object.assign({}, this.addSourceData(ctorNode, { kind: "constructor", id: id + "^constructor" }), { type: "Function", params: this.getParams(ctor[0], id) });
            }
            props = props.filter(prop => prop.escapedName != "prototype");
            // FIXME I haven't found a less weird way to get the instance type
            let instanceType = ctor.length && ctor[0].getReturnType();
            if (instanceType) {
                let protoProps = instanceType.getProperties();
                if (protoProps.length)
                    this.gatherSymbols(protoProps, out.instanceProperties = {}, id + ".");
            }
            if (props.length)
                this.gatherSymbols(props, out.properties = {}, id + "^");
            return out;
        }
        let out = { type: type.symbol.flags & typescript_1.SymbolFlags.Interface ? "interface" : "Object" };
        if (call.length)
            this.addCallSignature(call[0], out, id);
        if (props.length)
            this.gatherSymbols(props, out.properties = {}, id + ".");
        return out;
    }
    typeSource(type) {
        return relative(process.cwd(), decl(type.symbol).getSourceFile().fileName);
    }
    getParams(signature, id) {
        return signature.getParameters().map(param => {
            return Object.assign({ name: name(param) }, this.getType(this.symbolType(param), id + "^" + param.escapedName));
        });
    }
    addCallSignature(signature, target, id) {
        target.params = this.getParams(signature, id);
        let ret = signature.getReturnType();
        if (!(ret.flags & typescript_1.TypeFlags.Void))
            target.returns = this.getType(ret, id);
        return target;
    }
    symbolType(symbol) {
        let type = this.tc.getTypeOfSymbolAtLocation(symbol, decl(symbol));
        // FIXME this is weird and silly but for interface declarations TS gives a symbol type of any
        if (!type.symbol || type.flags & typescript_1.TypeFlags.Any)
            type = this.tc.getDeclaredTypeOfSymbol(symbol);
        return type;
    }
    addSourceData(node, target) {
        let comment = getComment(node);
        if (comment)
            target.description = comment;
        // FIXME add description comments
        const sourceFile = node.getSourceFile();
        if (!sourceFile)
            return target; // Synthetic node
        let { pos } = node;
        while (typescript_1.isWhiteSpaceLike(sourceFile.text.charCodeAt(pos)))
            ++pos;
        const { line, character } = typescript_1.getLineAndCharacterOfPosition(sourceFile, pos);
        target.loc = { file: relative(process.cwd(), sourceFile.fileName), line: line + 1, column: character };
        return target;
    }
}
function name(symbol) { return symbol.escapedName; }
function decl(symbol) {
    let result = symbol.valueDeclaration || symbol.declarations[0];
    if (!result)
        throw new Error(`No declaration available for symbole ${symbol.escapedName}`);
    return result;
}
function hasDecl(symbol) {
    return !!symbol.valueDeclaration || symbol.declarations.length > 0;
}
function getComment(node) {
    let { pos } = node;
    const sourceFile = node.getSourceFile();
    if (!sourceFile)
        return ""; // Synthetic node
    const { text } = sourceFile;
    let result = "", blankLine = false;
    while (pos < text.length) {
        const ch = text.charCodeAt(pos);
        if (ch === 47) { // slash
            const nextCh = text.charCodeAt(pos + 1);
            if (nextCh === 47) {
                if (blankLine) {
                    blankLine = false;
                    result = "";
                }
                let start = -1;
                pos += 2;
                for (; pos < text.length; ++pos) {
                    const ch = text.charCodeAt(pos);
                    if (start < 0 && !typescript_1.isWhiteSpaceSingleLine(ch))
                        start = pos;
                    if (typescript_1.isLineBreak(ch))
                        break;
                }
                if (start > 0) {
                    let line = text.substr(start, pos - start);
                    result += (result && !/\s$/.test(result) ? " " : "") + line;
                }
            }
            else if (nextCh === 42) { // asterisk
                if (blankLine) {
                    blankLine = false;
                    result = "";
                }
                const start = pos + 2;
                for (pos = start; pos < text.length; ++pos)
                    if (text.charCodeAt(pos) === 42 /* asterisk */ && text.charCodeAt(pos + 1) === 47 /* slash */)
                        break;
                result += text.substr(start, pos - start);
                pos += 2;
            }
        }
        else if (typescript_1.isWhiteSpaceLike(ch)) {
            pos++;
            if (ch == 10 && text.charCodeAt(pos) == 10)
                blankLine = true;
        }
        else {
            break;
        }
    }
    return result;
}
function gather({ filename, items = Object.create(null) }) {
    const configPath = typescript_1.findConfigFile(filename, typescript_1.sys.fileExists);
    const host = typescript_1.createCompilerHost({});
    const options = configPath ? typescript_1.getParsedCommandLineOfConfigFile(configPath, {}, host).options : {};
    const program = typescript_1.createProgram({ rootNames: [filename], options, host });
    const tc = program.getTypeChecker();
    const exports = tc.getExportsOfModule(tc.getSymbolAtLocation(program.getSourceFile(filename)));
    const basedir = resolve(dirname(configPath || filename));
    const module = new Module(tc, exports, basedir);
    module.gatherSymbols(exports, items, "");
    return items;
}
exports.gather = gather;
//# sourceMappingURL=index.js.map