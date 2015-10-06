/// <reference path='../node_modules/immutable/dist/immutable.d.ts' />
/// <reference path='../typings/bluebird/bluebird.d.ts' />
/// <reference path="../typings/debug/debug.d.ts"/>
/// <reference path="../typings/lodash/lodash.d.ts" />
/// <reference path='../typings/node/node.d.ts' />
/// <reference path='./zip.d.ts' />

'use strict';

import _ = require('lodash');
import assert = require('assert');
import BluePromise = require('bluebird');
import debug = require('debug');
import fs = require('fs');
import Immutable = require('immutable');
import TsJavaOptions = require('./TsJavaOptions');
import Work = require('./work');
import zip = require('zip');

import reflection = require('./reflection');
import Java = reflection.Java;

var openAsync = BluePromise.promisify(fs.open);

var dlog = debug('ts-java:classes-map');
var ddbg = debug('ts-java:classes-map-dbg');

var requiredCoreClasses: string[] = [
  'java.lang.Object',
  'java.lang.String',
];

interface Dictionary<T> {
  [index: string]: T;
}

type StringDictionary = Dictionary<string>;

// One method's variants, grouped by method signature.
type VariantsBySignature = Dictionary<MethodDefinition>;

// All of one class's methods in a doubly-indexed map, by method name then by method signature.
type MethodsByNameBySignature = Dictionary<VariantsBySignature>;

var reservedShortNames: StringDictionary = {
  'Number': null
};

import ClassDefinition = ClassesMap.ClassDefinition;
import ClassDefinitionMap = ClassesMap.ClassDefinitionMap;
import FieldDefinition = ClassesMap.FieldDefinition;
import MethodDefinition = ClassesMap.MethodDefinition;
import ParsedPrototype = ClassesMap.ParsedPrototype;
import VariantsArray = ClassesMap.VariantsArray;

export enum ParamContext {eInput, eReturn};

// ## ClassesMap
// ClassesMap is a map of a set of java classes/interfaces, containing information extracted via Java Reflection.
// For each such class/interface, we extract the set of interfaces inherited/implemented by the class,
// and information about all methods implemented by the class (directly or indirectly via inheritance).
export class ClassesMap {

  // *unhandledTypes* is the set of all types that are not included by the configured classes/packages lists
  // yet are referenced by methods of classes that are included in the output java.d.ts file.
  public unhandledTypes: Immutable.Set<string>;

  // *unhandledInterfaces* are any excluded types that are interfaces of included types.
  public unhandledInterfaces: Immutable.Set<string>;

  // *unhandledSuperClasses* are any excluded that are superclasses of included types.
  public unhandledSuperClasses: Immutable.Set<string>;

  private classCache: Immutable.Map<string, Java.Class>;

  private options: TsJavaOptions;

  private classes: ClassDefinitionMap;
  private includedPatterns: Immutable.Set<RegExp>;

  // shortToLongNameMap is used to detect whether a class name unambiguously identifies one class path.
  private shortToLongNameMap: StringDictionary;

  // allClasses is the list of all classes that should appear in the output java.d.ts file.
  // The list is created via two steps:
  // 1) Scan the jars in the class path for all classes matching the inWhiteList filter.
  // 2) Remove any non-public classes from the list.
  private allClasses: Immutable.Set<string>;

  // allExcludedClasses is the list of all classes seen in the classpath that were excluded
  // by the configuration.
  private allExcludedClasses: Immutable.Set<string>;

  private interfaceDepthCache: Immutable.Map<string, number>;

  private Modifier: Java.Modifier.Static = Java.importClass('java.lang.reflect.Modifier');

  constructor(options: TsJavaOptions) {
    this.options = options;

    this.classCache = Immutable.Map<string, Java.Class>();
    this.classes = {};
    this.unhandledTypes = Immutable.Set<string>();
    this.unhandledInterfaces = Immutable.Set<string>();
    this.unhandledSuperClasses = Immutable.Set<string>();
    this.allClasses = Immutable.Set<string>();
    this.allExcludedClasses = Immutable.Set<string>();

    this.Modifier = Java.importClass('java.lang.reflect.Modifier');

    // shortToLongNameMap is initialized by createShortNameMap(), in the initialize() sequence,
    // before analyzeIncludedClasses() is called.
    this.shortToLongNameMap = null;

    this.interfaceDepthCache = Immutable.Map<string, number>();

    this.includedPatterns = Immutable.Set(_.map(this.options.packages, (expr: string) => {
      var pattern: RegExp = this.packageExpressionToRegExp(expr);
      dlog('package pattern:', pattern);
      return pattern;
    }));

    var seeds = Immutable.Set(requiredCoreClasses).merge(options.classes);
    seeds.forEach((className: string) => {
      if (!this.inWhiteList(className)) {
        var pattern = new RegExp('^' + className.replace(/([\.\$])/g, '\\$1') + '$');
        this.includedPatterns = this.includedPatterns.add(pattern);
      }
    });
  }

  // *initialize()*: fully initialize from configured packages & classes.
  public initialize(): BluePromise<void> {
    return BluePromise.resolve()
      .then(() => this.preScanAllClasses())
      .then(() => this.loadClassCache())
      .then(() => this.createShortNameMap())
      .then(() => this.analyzeIncludedClasses());
  }

  // *fixGenericNestedTypeName()*: given a className returned by java reflection for generics,
  // check to see if the className appears to be a nested class name with the outer class redundantly specified.
  // If so, remove the redundant outer class name.
  public fixGenericNestedTypeName(className: string) {
    var m: Array<string> = /^([\w\.]+)\.\1\$(.+)$/.exec(className);
    if (m) {
      className = m[1] + '$' + m[2];
    }
    return className;
  }

  // *classNameOnly()*: Given a string that is either a classname, or a generic type, return just the classname.
  // This method should only be called in contexts where the name is a known classname or generic type name,
  // but for defensive programming purposes we thrown an exception if the name is not known.
  public classNameOnly(possiblyGenericClassName: string) {
    var genericTypeExp: RegExp = /^(.*)<(.*)>$/;
    var m: Array<string> = genericTypeExp.exec(possiblyGenericClassName);
    var className: string = m ? m[1] : possiblyGenericClassName;
    className = this.fixGenericNestedTypeName(className);

    // For defensive programming purposes, let's confirm that className is a legitimate className,
    // (seen while scanning all classes in the classpath):
    var isKnown: boolean = this.allClasses.has(className) || this.allExcludedClasses.has(className);
    if (!isKnown) {
      throw new Error(possiblyGenericClassName + ' is not a known className');
    }

    return className;
  }

  // *isIncludedClass()*: Return true if the class will appear in the output java.d.ts file.
  // All such classes 1) match the classes or package expressions in the tsjava section of the package.json,
  // and 2) are public.
  public isIncludedClass(className: string): boolean {
    return this.allClasses.has(this.classNameOnly(className));
  }

  // *isExcludedClass()*: return true if className was seen in classpath, but excluded by configuration.
  // Return false if the className was seen in classpath and allowed by configuration.
  // Throws exception for unrecognized class name.
  // If className appears to be a generic type, perform the test on just the classname.
  public isExcludedClass(className: string) {
    var genericTypeExp: RegExp = /^(.*)<(.*)>$/;
    var m: Array<string> = genericTypeExp.exec(className);
    if (m) {
      className = m[1];
    }
    var isExcluded: boolean = this.allExcludedClasses.has(className);
    if (!isExcluded) {
      // For defensive programming purposes, let's confirm that className is a legitimate className,
      // by confirming that it exists in the allClasses list:
      var isKnown: boolean = this.allClasses.has(className);
      if (!isKnown) {
        throw new Error(className + ' is not a known className');
      }
    }
    return isExcluded;
  }

  // *getSortedClasses()*: return a sorted array of classes.
  public getSortedClasses(): Array<ClassDefinition> {
    return this.flattenDictionary(this.classes);
  }

  // *getClasses()*: return the map of all classes. Keys are classnames, values are classMaps.
  public getClasses(): ClassDefinitionMap {
    return this.classes;
  }

  // *getAllClasses()*: Return the set of all classes selected by the configuration, i.e. appearing in output java.d.ts.
  public getAllClasses(): Immutable.Set<string> {
    return this.allClasses;
  }

  // *getOptions()*: Return the TsJavaOptions used to configure this ClassesMap.
  public getOptions(): TsJavaOptions {
    return this.options;
  }

  // *packageExpressionToRegExp()*: Return a RegExp equivalent to the given package expression.
  public packageExpressionToRegExp(expr: string): RegExp {
    if (/\.\*$/.test(expr)) {
      // package string ends with .*
      expr = expr.slice(0, -1); // remove the *
      expr = expr + '[\\w\\$]+$'; // and replace it with expression designed to match exactly one classname string
    } else if (/\.\*\*$/.test(expr)) {
      // package string ends with .**
      expr = expr.slice(0, -2); // remove the **
    }
    expr = '^' + expr.replace(/\./g, '\\.');
    return new RegExp(expr);
  }

  public stackTrace(msg: string): void {
    var c: any = <any> console;
    c.trace(msg);
    process.abort();
  }

  // This function is temporary while conducting a refactoring.
  public tsTypeNameInputEncoded(javaTypeName: string): string {
    return this.tsTypeName(javaTypeName, ParamContext.eInput, true);
  }


  // #### **jniDecodeType()**: given a java type name, if it is a JNI encoded type string, decode it.
  // The `encodedTypes` parameter indicates that JNI type strings such as `Ljava.lang.Object;` are expected.
  // It is temporary instrumentation until this refactoring is complete.
  public jniDecodeType(javaTypeName: string, encodedTypes: boolean = false): { typeName: string, ext: string } {
    var typeName: string = javaTypeName;

    var ext = '';
    while (typeName[0] === '[') {
      if (!encodedTypes) { this.stackTrace(javaTypeName); }
      typeName = typeName.slice(1);
      ext += '[]';
    }

    var m = typeName.match(/^L(.*);$/);
    if (m) {
      if (!encodedTypes) { this.stackTrace(javaTypeName); }
      typeName = m[1];
    }

    // First convert the 1-letter JNI abbreviated type names to their human readble types
    var jniAbbreviations: StringDictionary = {
      // see http://docs.oracle.com/javase/7/docs/technotes/guides/jni/spec/types.html
      B: 'byte',
      C: 'char',
      D: 'double',
      F: 'float',
      I: 'int',
      J: 'long',
      S: 'short',
      Z: 'boolean'
    };
    if (typeName in jniAbbreviations) {
      if (!encodedTypes) { this.stackTrace(javaTypeName); }
      typeName = jniAbbreviations[typeName];
    }

    return {typeName, ext};
  }

  // #### **boxIfJavaPrimitive()**: if typeName is a primitive type, return the boxed Object type.
  public boxIfJavaPrimitive(typeName: string): string {
    var primitiveToObjectMap: StringDictionary = {
      'byte': 'java.lang.Object',
      'char': 'java.lang.Object',
      'boolean': 'java.lang.Boolean',
      'short': 'java.lang.Short',
      'long' : 'java.lang.Long',
      'int': 'java.lang.Integer',
      'float': 'java.lang.Float',
      'double': 'java.lang.Double'
    };
    if (typeName in primitiveToObjectMap) {
      typeName = primitiveToObjectMap[typeName];
    }
    return typeName;
  }

  // #### **mapUnhandledTypesToJavaLangObject()**: if typeName is a java class not included by configuration,
  // record that the class is 'unhandled', and instead use java.lang.Object.
  public mapUnhandledTypesToJavaLangObject(typeName: string): string {
    if (typeName !== 'void' && !this.isIncludedClass(typeName)) {
      // Since the type is not in our included classes, we might want to use the Typescript 'any' type.
      // However, array_t<any> doesn't really make sense. Rather, we want array_t<Object>,
      // or possibly instead of Object a superclass that is in our whitelist.
      this.unhandledTypes = this.unhandledTypes.add(typeName);
      typeName = 'java.lang.Object';
    }
    return typeName;
  }

  // #### **mapJavaPrimitivesToTypescript()**: For primitive (boxed) types, return the corresponding Typescript type.
  // The typescript type depends on the context, whether the type is in input parameter or function return type.
  public mapJavaPrimitivesToTypescript(typeName: string, context: ParamContext): string {
    // Finally, convert Java primitive types to Typescript primitive types.

    // node-java does type translation for a set of common/primitive types.
    // Translation is done both for function input parameters, and function return values.
    // In general, it's not a 1-1 mapping between types.
    // For function input parameters, we generaly need union types, so that methods can accept
    // either javascript values, or java values (object pointers of a given Java type).
    // Function return results are always a single type, but several java types may map to
    // one javascript type (e.g. number).

    // string_t is a union type [string|java.lang.String] defined in the handlebars template.
    // Likewise object_t is the union type [string|java.lang.Object], a special case because it
    // is common to pass a string to methods that are declared to take Object.
    // (This may change when we implement generics).

    // java.lang.Long type requires special handling, since javascript does not have 64-bit integers.
    // For return values, node-java returns a Number that has an additional key 'longValue' holding a string
    // representation of the full long integer. The value of the Number itself is the best floating point
    // approximation (53 bits of the mantissa plus an exponent).
    // We define an interface longValue_t (in package.txt) that that extends Number and adds a string member longValue.
    // We also define long_t, which is the union [number|longValue_t|java.lang.Long].

    var javaTypeToTypescriptType: StringDictionary = {
      void: 'void',
      'java.lang.Boolean': context === ParamContext.eInput ? 'boolean_t' : 'boolean',
      'java.lang.Double':  context === ParamContext.eInput ? 'double_t' : 'number',
      'java.lang.Float':   context === ParamContext.eInput ? 'float_t' : 'number',
      'java.lang.Integer': context === ParamContext.eInput ? 'integer_t' : 'number',
      'java.lang.Long':    context === ParamContext.eInput ? 'long_t' : 'longValue_t',
      'java.lang.Number':  context === ParamContext.eInput ? 'number_t' : 'number',
      'java.lang.Object':  context === ParamContext.eInput ? 'object_t' : 'object_t', // special case
      'java.lang.Short':   context === ParamContext.eInput ? 'short_t' : 'number',
      'java.lang.String':  context === ParamContext.eInput ? 'string_t' : 'string'
    };

    if (typeName in javaTypeToTypescriptType) {
      typeName = javaTypeToTypescriptType[typeName];
    }

    return typeName;
  }

  // #### **getJavaAliasName()**: given a java full classname string, return the aliased short name.
  // In cases where the the short class name is ambiguous, return the full name.
  // In all cases, add the 'Java.' namespace qualifier.
  public getJavaAliasName(className: string): string {
    var typeName = className;
    assert.ok(this.isIncludedClass(typeName));
    var shortName = this.shortClassName(typeName);
    if (this.shortToLongNameMap[shortName] === typeName) {
      typeName = shortName;
    }
    // Add the 'Java.' namespace
    typeName = 'Java.' + typeName;
    return typeName;
  }

  // #### **tsTypeName()**: given a java type name, return a typescript type name
  // declared public only for unit tests
  // The `encodedTypes` parameter is a hack put in place to assist with a refactoring.
  // tsTypeName() needs to be split up into functions that handle different aspects of the typename transformation.
  public tsTypeName(javaTypeName: string, context: ParamContext = ParamContext.eInput, encodedTypes: boolean = false): string {
    var {typeName, ext} = this.jniDecodeType(javaTypeName, encodedTypes);

    typeName = this.boxIfJavaPrimitive(typeName);
    typeName = this.mapUnhandledTypesToJavaLangObject(typeName);

    var mappedType: string = this.mapJavaPrimitivesToTypescript(typeName, context);

    if (mappedType !== typeName || typeName === 'void') {
      typeName = mappedType;
    } else if (this.isIncludedClass(typeName)) {
      typeName = this.getJavaAliasName(typeName);
    } else {
      dlog('Unhandled type:', typeName);
      this.unhandledTypes = this.unhandledTypes.add(typeName);
      typeName = 'any';
    }

    // Handle arrays
    assert.ok(ext.length % 2 === 0);  // ext must be sequence of zero or more '[]'.
    if (ext === '') {
      // A scalar type, nothing to do here
    } else if (context === ParamContext.eReturn) {
      // Functions that return a Java array are thunked by node-java to return a
      // javascript array of the corresponding type.
      // This seems to work even for multidimensional arrays.
      typeName = typeName + ext;
    } else if (ext === '[]') {
      // Node-java has support for 1d arrays via newArray. We need the special opaque type array_t<T> to
      // model the type of these array objects.
      typeName = 'array_t<' + typeName  + '>';
    } else {
      // This final else block handles two cases for multidimensial arrays:
      // 1) When used as a function input.
      // 2) When returned as a function result, and the element type is not a primitive.
      // Node-java currently doesn't handle these cases. We use the 'void' type here so that
      // such uses will be flagged with an error at compile time.
      this.unhandledTypes = this.unhandledTypes.add(typeName + ext);
      typeName = 'void';
    }

    return typeName;
  }

  // *isSimpleName()*: Returns true if the string s is a simple name, i.e. one word composed of
  // alphanumeric characters plus $
  public isSimpleName(s: string): boolean {
    return s.match(/^\w+$/) !== null;
  }

  // *translateIfPrimitiveType()*: If s is a Java primitive type, return the corresponding Typescript type.
  public translateIfPrimitiveType(s: string, context: ParamContext = ParamContext.eInput): string {
    var translated = this.boxIfJavaPrimitive(s);
    if (translated !== s) {
      translated = this.mapJavaPrimitivesToTypescript(translated, context);
    }
    return translated;
  }

  // *translateFullClassPathsToShortAlias()*: Given a string which may be a java generic type string,
  // find all full java class paths and translate them to their short alias names.
  public translateFullClassPathsToShortAlias(javaGenericType: string): string {
    // javaGenericType might be a complex type, say java.util.List<java.lang.Class<?>>
    // The translated result would be: Java.List<Java.Class<?>>
    var translated: string = javaGenericType;
    var re: RegExp = /[\w\$\.]+/g;
    var m: Array<string>;
    while ((m = re.exec(translated)) !== null) {
      var name: string = m[0];
      var tname = this.fixGenericNestedTypeName(name);
      if (this.isSimpleName(tname)) {
        // This should catch generic free variables (T, E) as well as primitive types (int, long, ...)
        tname = this.translateIfPrimitiveType(tname);
      } else if (this.isIncludedClass(tname)) {
        tname = this.getJavaAliasName(tname);
      } else {
        assert(this.isExcludedClass(tname));
        tname = 'any';
      }
      translated = translated.replace(name, tname);
      re.lastIndex -= name.length - tname.length;
    }

    return translated;
  }

  // *translateGenericTypeLists()*: Given a string that may be a java generic type, find all generic
  // constraint expressions <...> and translate them to the best corresponding typescript constraint.
  public translateGenericTypeLists(javaGenericType: string): string {
    // javaGenericType might be a complex type, for example java.util.List<java.lang.Class<?>>
    // As in the example, there may be nested expressions. The algorithm that follows processes
    // the innermost expressions first, replacing the angle brackets < and > with utf8 characters « and ».
    // When all angle brackets have been translated, we make one last pass to restore them.

    if (javaGenericType.indexOf('<') === -1) {
      return javaGenericType;
    }

    var translated: string = javaGenericType;
    var done: boolean = false;

    while (!done) {
      done = true;
      // The regexp re finds generic type expressions foo<...>.
      var re: RegExp = /([\w\$\.]+)<([^<>]+)>/g;
      var m: Array<string>;
      while ((m = re.exec(translated)) != null) {
        done = false;
        var parts: string[] = m[2].split(',');
        parts = _.map(parts, (s: string) => {
          s = s.trim();

          // Typescript doesn't have wildcards in generics.
          // But I believe an upper bound wildcard expression '? extends T' can be safely translated to 'T'.
          s = s.replace(/\? extends /, '');

          // Typescript doesn't have lower bound expressions at all.
          // Replacing '? super T' with 'T' will be wrong in nearly all cases, so we just replace the whole
          // constraint with 'any'.
          // But we also need to translate '?' to 'any', so we combine these two cases by just translating
          // any constraint that starts with ? to 'any'
          if (s[0] === '?') { s = 'any'; }
          return s;
        });

        // The generic type expression original matched above might be of the form any<...>.
        // This happens when a Java generic class is excluded by configuration.
        // In that case we have to omit the match generic types <...>, and just return 'any'.
        var reconstructed: string;
        if (m[1] === 'any') {
          reconstructed = 'any';
        } else {
          reconstructed = m[1] + '«' + parts.join('‡') + '»';
        }

        translated = translated.replace(m[0], reconstructed);
        re.lastIndex -= m[0].length - reconstructed.length;
      }
    }

    translated = translated.replace(/«/g, '<').replace(/»/g, '>').replace(/‡/g, ', ');
    return translated;
  }

  // *translateGenericType()*: Given a string that may be a java generic type, return the best translation
  // to a typescript type.
  public translateGenericType(javaGenericType: string): string {
    var tsGenericType = javaGenericType;

    // Detect if the type is an array type. If it is strip the string of [] from the type, to be restored later.
    var m: Array<string> = tsGenericType.match(/^([^\[]+)(\[\])+$/);
    if (m) {
      tsGenericType = m[1];
    }

    tsGenericType = this.translateFullClassPathsToShortAlias(tsGenericType);
    tsGenericType = this.translateGenericTypeLists(tsGenericType);

    if (m) {
      tsGenericType = tsGenericType + m[2];
    }

    return tsGenericType;
  }

  // *mapMethod()*: return a map of useful properties of a method or constructor.
  // For our purposes, we can treat constructors as methods except for the handling of return type.
  // declared public only for unit tests
  public mapMethod(method: Java.Executable): MethodDefinition {

    var signature = this.methodSignature(method);

    var isStatic: boolean = this.Modifier.isStatic(method.getModifiers());

    var returnType: string = 'void';
    var genericReturnType: string = returnType;
    if ('getReturnType' in method) {
      returnType = (<Java.Method>method).getReturnType().getName();
      genericReturnType = (<Java.Method>method).getGenericReturnType().getTypeName();
    } else {
      // It is convenient to declare the return type for a constructor to be the type of the class,
      // possibly transformed by tsTypeName. This is because node-java will always convert boxed primitive
      // types to the corresponding javascript primitives, e.g. java.lang.String -> string, and
      // java.lang.Integer -> number.
      returnType = method.getDeclaringClass().getName();
      genericReturnType = method.getDeclaringClass().getTypeName();
    }

    var generic_proto: string = method.toGenericString();
    var ts_generic_proto: ParsedPrototype = this.translateGenericProto(generic_proto);

    var tsReturnsRegular = this.tsTypeName(returnType, ParamContext.eReturn, true);
    var tsGenericReturns = this.translateGenericType(genericReturnType);
    var tsReturns = this.options.generics ? tsGenericReturns : tsReturnsRegular;

    var tsGenericParamTypes: Array<string> = _.map(method.getGenericParameterTypes(), (p: Java.Type) => {
      return this.translateGenericType(p.getTypeName());
    });

    var methodMap: MethodDefinition = {
      name: method.getName(),
      declared: method.getDeclaringClass().getName(),
      returns: returnType,
      genericReturns: genericReturnType,
      tsReturnsRegular: tsReturnsRegular,
      tsGenericReturns: tsGenericReturns,
      tsReturns: tsReturns,
      paramNames: _.map(method.getParameters(), (p: Java.Parameter) => { return p.getName(); }),
      paramTypes: _.map(method.getParameterTypes(), (p: Java.Class) => { return p.getName(); }),
      tsParamTypes: _.map(method.getParameterTypes(), (p: Java.Class) => { return this.tsTypeNameInputEncoded(p.getName()); }),
      genericParamTypes: _.map(method.getGenericParameterTypes(), (p: Java.Type) => p.getTypeName()),
      tsGenericParamTypes: tsGenericParamTypes,
      tsTypeParameters: _.map(method.getTypeParameters(), (p: Java.TypeVariable) => { return p.getName(); }),
      isStatic: isStatic,
      isVarArgs: method.isVarArgs(),
      generic_proto: generic_proto,
      ts_generic_proto: ts_generic_proto,
      plain_proto: method.toString(),
      signature: signature
    };

    return methodMap;
  }

  // *mapClassMethods()*: return a methodMap array for the methods of a class
  // declared public only for unit tests
  public mapClassMethods(className: string, clazz: Java.Class): Array<MethodDefinition> {
    return _.map(clazz.getMethods(), function (m: Java.Method) { return this.mapMethod(m); }, this);
  }

  // *mapClass()*: return a map of all useful properties of a class.
  // declared public only for unit tests
  public mapClass(className: string, work: Work): ClassDefinition {
    var clazz: Java.Class = this.getClass(className);
    assert.strictEqual(className, clazz.getName());

    var genericName: string = clazz.toGenericString();
    var classTypeName: string = clazz.getTypeName();

    var annotations: string[] = _.map(clazz.getAnnotations(), (anno: Java.Annotation) => anno.toString());

    var typeParms: Array<string> = _.map(clazz.getTypeParameters(), (t: Java.TypeVariable) => t.getName());

    // Get the superclass of the class, if it exists, and is an included class.
    // If the immediate type is not an included class, we ascend up the ancestry
    // until we find an included superclass. If none exists, we declare the
    // class to not have a superclass, even though it does.
    // We report all such skipped superclasses in the summary diagnostics.
    // The developer can then choose to add any of these classes to the seed classes list.
    var superclass: Java.Class = clazz.getSuperclass();
    while (superclass && !this.isIncludedClass(superclass.getName())) {
      this.unhandledSuperClasses = this.unhandledSuperClasses.add(superclass.getName());
      superclass = superclass.getSuperclass();
    }

    var interfaces: Array<string> = this.mapClassInterfaces(className, clazz).sort();
    if (superclass) {
      interfaces.unshift(superclass.getName());
    }

    interfaces.forEach((intfName: string) => {
      if (!work.alreadyDone(intfName)) {
        work.addTodo(intfName);  // needed only to simplify a unit test. Normally a no-op.
        dlog('Recursing in mapClass to do inherited interface:', intfName);
        this.classes[intfName] = this.mapClass(intfName, work);
        work.setDone(intfName);
      }
    });

    var tsGenericInterfaces: Array<string> = _.map(clazz.getGenericInterfaces(), (genType: Java.Type) => {
      return this.translateGenericType(genType.getTypeName());
    });
    tsGenericInterfaces = _.filter(tsGenericInterfaces, (intf: string) => intf !== 'any');

    var methods: Array<MethodDefinition> = this.mapClassMethods(className, clazz).sort(bySignature);
    var fields: Array<FieldDefinition> = this.mapClassFields(className, clazz);

    var constructors: Array<MethodDefinition> = this.mapClassConstructors(className, clazz);

    var shortName: string = this.shortClassName(className);
    var alias: string = shortName;
    var useAlias: boolean = true;

    if (this.shortToLongNameMap[shortName] !== className) {
      alias = className;
      useAlias = false;
    }

    var isInterface = clazz.isInterface();
    var isPrimitive = clazz.isPrimitive();
    var isEnum = clazz.isEnum();

    function bySignature(a: MethodDefinition, b: MethodDefinition) {
      return a.signature.localeCompare(b.signature);
    }

    var tsRegularInterfaces = _.map(interfaces, (intf: string) => { return this.fixClassPath(intf); });

    // tsRegularInterfaces is used in the extends clause of an interface declaration.
    // Each intf is an interface name is a fully scoped java path, but in typescript
    // these paths are all relative paths under the output module Java.
    // In most cases it is not necessary to include the 'Java.' module in the interface
    // name, but in few cases leaving it out causes naming conflicts, most notably
    // between java.lang and groovy.lang.
    tsRegularInterfaces = _.map(tsRegularInterfaces, (intf: string) => { return 'Java.' + intf; });

    var tsInterfaces = this.options.generics ? tsGenericInterfaces : tsRegularInterfaces;

    var variantsDict: MethodsByNameBySignature = this.groupMethods(methods);

    this.mergeOverloadedVariants(variantsDict, interfaces);

    var variants: VariantsArray = _.map(variantsDict, (bySig: VariantsBySignature) =>
                                                        this.flattenDictionary(bySig).sort(this.compareVariants));

    var classMap: ClassDefinition = {
      quotedPkgName: this.packageName(this.fixClassPath(className)),
      packageName: this.packageName(className),
      genericName: genericName,
      annotations: annotations,
      classTypeName: classTypeName,
      fullName: className,
      shortName: shortName,
      typeParms: typeParms,
      alias: alias,
      useAlias: useAlias,
      tsType: this.tsTypeName(className) + this.unconstrainedTypeList(typeParms),
      isInterface: isInterface,
      isPrimitive: isPrimitive,
      superclass: superclass === null ? null : superclass.getName(),
      interfaces: interfaces,
      tsRegularInterfaces: tsRegularInterfaces,
      tsGenericInterfaces: tsGenericInterfaces,
      tsInterfaces: tsInterfaces,
      methods: methods,
      constructors: constructors.sort(this.compareVariants),
      variantsDict: variantsDict,
      variants: variants,
      isEnum: isEnum,
      fields: fields
    };

    return classMap;
  }

  // *inWhiteList()*: Return true for classes of interest.
  // declared public only for unit tests
  public inWhiteList(className: string): boolean {
    var allowed: boolean = this.includedPatterns.find((ns: RegExp) => { return className.match(ns) !== null; }) !== undefined;
    if (allowed) {
      var isAnon: boolean = /\$\d+$/.test(className);
      if (isAnon) {
        dlog('Filtering out anon class:', className);
        allowed = false;
      }
    }
    return allowed;
  }

  // *shortClassName()*: Return the short class name given the full className (class path).
  // declared public only for unit tests
  public shortClassName(className: string): string {
    return _.last(className.split('.'));
  }

  // *getClass()*: get the Class object for the given full class name.
  // declared public only for unit tests
  public getClass(className: string): Java.Class {
    var clazz = this.classCache.get(className);
    if (!clazz) {
      // For historical reasons, we simulate the exception thrown when the Java classloader doesn't find class
      throw new Error('java.lang.ClassNotFoundException:' + className);
    }
    return clazz;
  }

  // *mapClassInterfaces()*: Find the direct interfaces of className.
  // declared public only for unit tests
  public mapClassInterfaces(className: string, clazz: Java.Class) : Array<string> {
    assert.strictEqual(clazz.getName(), className);
    var interfaces: Array<string> = this.resolveInterfaces(clazz).toArray();

    // Methods of Object must always be available on any instance variable, even variables whose static
    // type is a Java interface. Java does this implicitly. We have to do it explicitly.
    var javaLangObject = 'java.lang.Object';
    if (interfaces.length === 0 && className !== javaLangObject && clazz.getSuperclass() === null) {
      interfaces.push(javaLangObject);
    }

    return interfaces;
  }

  // *fixClassPath()*: given a full class path name, rename any path components that are reserved words.
  // declared public only for unit tests
  public fixClassPath(fullName: string): string {
    var reservedWords = [
      // TODO: include full list of reserved words
      'function',
      'package'
    ];
    var parts = fullName.split('.');
    parts = _.map(parts, (part: string) => {
      if (_.indexOf(reservedWords, part) === -1) {
        return part;
      } else {
        return part + '_';
      }
    });
    return parts.join('.');
  }

  // *translateGenericProto()*: given a string that is a Java generic method prototype
  // (as returned by Method.toGenericString()), return a complete Typescript generic method prototype.
  // declared public only for unit tests
  public translateGenericProto(generic_proto: string): ParsedPrototype {
    var tmp: string = generic_proto;

    tmp = tmp.replace('abstract ', '');
    tmp = tmp.replace('default ', '');
    tmp = tmp.replace('final ', '');
    tmp = tmp.replace('native ', '');
    tmp = tmp.replace('public ', '');
    tmp = tmp.replace('static ', ''); // we'll recognize static methods a different way
    tmp = tmp.replace('synchronized ', '');
    tmp = tmp.replace(/ throws .*$/, '');

    // The last character should now be a ')', the close parenthesis of the function's parameter list.
    assert.strictEqual(tmp[tmp.length - 1], ')');

    // The regex below is gnarly. It's designed to capture four fields
    // gentypes: (<[, \w]+>)?          -- optional expression '<...> '
    // returns: (?:(.*) )?             -- Optional function return result (optional because of constructors)
    // methodName: ([\.\$\w]+)         -- requires word string, but may include $ characters
    // params: \((.*)\)                -- The parameter list, identified only by the parentheses

    var parse: string[] = tmp.match(/^(<[, \w]+>)?(?:(.*) )?([\.\$\w]+)\((.*)\)$/);
    assert.ok(parse);
    assert.strictEqual(parse.length, 5);
    ddbg(parse);

    var gentypes: string = parse[1] === undefined ? '' : parse[1];
    var returns: string = parse[2] || 'void';
    var methodName: string = parse[3].split('.').slice(-1)[0];
    var params: string = parse[4];

    // Split at commas, but ignoring commas between < > for generics
    function splitParams(s: string): Array<string> {
      // This function is a hack that takes advantage of the fact that Java Reflection
      // returns a prototype string that has no space after the commas we want to split at,
      // but does have a space after commas we want to ignore.
      var result: Array<string> = [];
      while (s.length > 0) {
        var i: number = s.search(/,[^\s]/);
        if (i === -1) {
          result.push(s);
          s = '';
        } else {
          result.push(s.slice(0, i));
          s = s.slice(i + 1);
        }
      }
      return result;
    }

    var result: ParsedPrototype = {
      methodName: methodName.trim(),
      gentypes: gentypes.trim(),
      returns: returns.trim(),
      params: splitParams(params)
    };

    ddbg('CHECK:', result);
    return result;
  }

  // *resolveInterfaces()*: Find the set of non-excluded interfaces for the given class `clazz`.
  // If an interface of a class is excluded by the configuration, we check the ancestors of that class.
  private resolveInterfaces(clazz: Java.Class): Immutable.Set<string> {
    var result = Immutable.Set<string>();

    _.forEach(clazz.getInterfaces(), (intf: Java.Class): void => {
      var intfName: string = intf.getName();
      if (this.isIncludedClass(intfName)) {
        result = result.add(intfName);
      } else {
        // Remember the excluded interface
        this.unhandledInterfaces = this.unhandledInterfaces.add(intfName);
        // recurse and merge results.
        result = result.merge(this.resolveInterfaces(intf));
      }
    });

    return result;
  }

  // *typeEncoding()*: return the JNI encoding string for a java class
  private typeEncoding(clazz: Java.Class): string {
    var name = clazz.getName();
    var primitives: StringDictionary = {
      boolean: 'Z',
      byte: 'B',
      char: 'C',
      double: 'D',
      float: 'F',
      int: 'I',
      long: 'J',
      short: 'S',
      void: 'V'
    };

    var encoding: string;
    if (clazz.isPrimitive()) {
      encoding = primitives[name];
    } else if (clazz.isArray()) {
      encoding = name;
    } else {
      encoding = clazz.getCanonicalName();
      assert.ok(encoding, 'typeEncoding cannot handle type');
      encoding = 'L' + encoding + ';';
    }

    return encoding.replace(/\./g, '/');
  }

  // #### **methodSignature()**: return the signature of a method, i.e. a string unique to any method variant,
  // encoding the method name, types of parameters, and the return type.
  // This string may be passed as the method name to java.callMethod() in order to execute a specific variant.
  private methodSignature(method: Java.Executable): string {
    var name = method.getName();
    var paramTypes = method.getParameterTypes();
    var sigs = paramTypes.map((p: Java.Class) => { return this.typeEncoding(p); });
    var signature = name + '(' + sigs.join('') + ')';
    if ('getReturnType' in method) {
      // methodSignature can be called on either a constructor or regular method.
      // constructors don't have return types.
      signature += this.typeEncoding((<Java.Method>method).getReturnType());
    }
    return signature;
  }

  // *mapField()*: return a map of useful properties of a field.
  private mapField(field: Java.Field): FieldDefinition {
    var name: string = field.getName();
    var fieldType: Java.Class = field.getType();
    var genericFieldType: Java.Type = field.getGenericType();
    var fieldTypeName: string = fieldType.getName();
    var declaredIn: string = field.getDeclaringClass().getName();
    var tsRegularType: string = this.tsTypeName(fieldTypeName, ParamContext.eReturn, true);
    var tsGenericType: string = this.translateGenericType(genericFieldType.getTypeName());
    var tsType: string = this.options.generics ? tsGenericType : tsRegularType;

    var isStatic: boolean = this.Modifier.isStatic(field.getModifiers());
    var isSynthetic: boolean = field.isSynthetic();

    var fieldDefinition: FieldDefinition = {
      name: name,
      tsRegularType: tsRegularType,
      tsGenericType: tsGenericType,
      tsType: tsType,
      isStatic: isStatic,
      isSynthetic: isSynthetic,
      declaredIn: declaredIn
    };

    return fieldDefinition;
  }

  // *mapClassFields()*: return a FieldDefinition array for the fields of a class
  private mapClassFields(className: string, clazz: Java.Class): Array<FieldDefinition> {
    var allFields: Array<Java.Field> = clazz.getFields();
    var allFieldDefs: Array<FieldDefinition> = _.map(allFields, (f: Java.Field) => this.mapField(f));

    // For instance fields, we should keep only the fields declared in this class.
    // We'll have access to inherited fields through normal inheritance.
    // If we kept the inherited fields, it would result in duplicate definitions in the derived classes.
    var instanceFieldDefs: Array<FieldDefinition> = _.filter(allFieldDefs, (f: FieldDefinition) => {
      return !f.isStatic && f.declaredIn === clazz.getName();
    });

    // For static fields we should keep all inherited fields, since the .Static interface of a class
    // does not extend the .Static interface of its parent(s).
    // But we can't simply keep all static fields, because (apparently) a class can redefine a static
    // field with the same name as an inherited field.
    var staticFieldDefs: Array<FieldDefinition>  = _.filter(allFieldDefs, (f: FieldDefinition) => f.isStatic);
    staticFieldDefs = _.uniq(staticFieldDefs, false, 'name');

    return instanceFieldDefs.concat(staticFieldDefs);
  }

  // *mapClassConstructors()*: return a methodMap array for the constructors of a class
  private mapClassConstructors(className: string, clazz: Java.Class): Array<MethodDefinition> {
    return _.map(clazz.getConstructors(), function (m: Java.Constructor) { return this.mapMethod(m); }, this);
  }

  // *compareVariants()*: Compare two method definitions, which should be two variants with the same method name.
  // We arrange to sort methods from most specific to most generic, as expected by Typescript.
  private compareVariants(a: MethodDefinition, b: MethodDefinition): number {
    function countArgsOfTypeAny(a: MethodDefinition): number {
      return _.filter(a.tsParamTypes, (t: string) => t === 'any').length;
    }

    // We want variants with more parameters to come first.
    if (a.paramTypes.length > b.paramTypes.length) {
      return -1;
    } else if (a.paramTypes.length < b.paramTypes.length) {
      return 1;
    }

    // For the same number of parameters, order methods with fewer 'any' arguments first
    if (countArgsOfTypeAny(a) < countArgsOfTypeAny(b)) {
      return -1;
    } else if (countArgsOfTypeAny(a) > countArgsOfTypeAny(b)) {
      return 1;
    }

    // For the same number of parameters, order the longer (presumably more complex) signature to be first
    if (a.signature.length > b.signature.length) {
      return -1;
    } else if (a.signature.length < b.signature.length) {
      return 1;
    }

    // As a penultimate catch-all, sort lexically by signature.
    var result: number = b.signature.localeCompare(a.signature);
    if (result !== 0) {
      return result;
    }

    // As a final catch-all, sort lexically by the generic proto signature.
    return a.generic_proto.localeCompare(b.generic_proto);
  }

  // *flattenDictionary()*: return an array of the dictionary's values, sorted by the dictionary's keys.
  private flattenDictionary<T>(dict: Dictionary<T>): T[] {
    function caseInsensitiveOrder(a: string, b: string): number {
      var A = a.toLowerCase();
      var B = b.toLowerCase();
      if (A < B) {
        return -1;
      } else if (A > B) {
        return  1;
      } else {
      return 0;
      }
    }
    var keys = _.keys(dict).sort(caseInsensitiveOrder);
    return _.map(keys, (key: string): T => dict[key]);
  }

  // *groupMethods()*: group methods first by name, and then by signature.
  private groupMethods(flatList: Array<MethodDefinition>): MethodsByNameBySignature {
    var result: MethodsByNameBySignature = {};
    _.forEach(flatList, (method: MethodDefinition) => {
      if (!_.has(result, method.name)) {
        result[method.name] = {};
      }
      result[method.name][method.signature] = method;
    });
    return result;
  }

  // *interfacesTransitiveClosure()*: return the transitive closure of all inherited interfaces given
  // a set of directly inherited interfaces.
  private interfacesTransitiveClosure(directInterfaces: string[]): string[] {
    var work: Work = new Work();
    directInterfaces.forEach((intf: string) => work.addTodo(intf));
    work.forEach((intf: string) => {
      this.classes[intf].interfaces.forEach((parent: string) => work.addTodo(parent));
    });
    return work.getDone().toArray();
  }

  // *interfaceDepth()*: return the 'depth' of a class in the class graph.
  // A class with no inherited interfaces has depth 0. We arrange so that java.lang.Object is the only such class.
  // Every other interface has a depth 1 greater than the maximum depth of any of its direct parent interfaces.
  private interfaceDepth(intf: string): number {
    if (this.interfaceDepthCache.has(intf)) {
      return this.interfaceDepthCache.get(intf);
    }

    var parents: string[] = this.classes[intf].interfaces;

    var intfDepth: number = 0;
    if (parents.length > 0) {
      var depths: number[] = _.map(parents, (parent: string) => this.interfaceDepth(parent));
      intfDepth = _.max(depths) + 1;
    }

    this.interfaceDepthCache = this.interfaceDepthCache.set(intf, intfDepth);
    return intfDepth;
  }

  // *mergeOverloadedVariants()*: Merge into a class's variants dictionary all inherited overloaded variants.
  // The algorithm intentionally overwrites any method definition with the definition from the inherited
  // interface that first declared it. The only sigificant difference between the original declaration and a later override
  // is the generic_proto field, which we render into the output .d.ts file as a comment before the method.
  private mergeOverloadedVariants(variantsDict: MethodsByNameBySignature, directInterfaces: string[]): void {
    var self = this;
    // Get the list of all inherited interfaces, ordered in descending order by interface depth.
    var interfaces: string[] = this.interfacesTransitiveClosure(directInterfaces)
      .sort((intf1: string, intf2: string): number => {
        return self.interfaceDepth(intf2) - self.interfaceDepth(intf1);
      });

    // for each method name of the class
    _.forEach(variantsDict, (methodVariants: VariantsBySignature, methodName: string) => {
      // for all inherited interfaces
      _.forEach(interfaces, (intfName: string) => {
        var intfVariantsDict: MethodsByNameBySignature = this.classes[intfName].variantsDict;
        // if the inherited interface declares any of the variants of the method
        if (_.has(intfVariantsDict, methodName)) {
          // merge all of the variants into the class's variants dictionary.
          _.assign(variantsDict[methodName], intfVariantsDict[methodName]);
        }
      });
    });
  }

  // *packageName()*: given a full class path name, return the package name.
  private packageName(className: string): string {
    var parts = className.split('.');
    parts.pop();
    return parts.join('.');
  }

  // *getWhitedListedClassesInJar()*: For the given jar, read the index, and return an array of all classes
  // from the jar that are selected by the configuration.
  private getWhitedListedClassesInJar(jarpath: string): BluePromise<Array<string>> {
    dlog('getWhitedListedClassesInJar started for:', jarpath);
    var result: Array<string> = [];
    return openAsync(jarpath, 'r')
      .then((fd: number) => {
        var reader = zip.Reader(fd);
        reader.forEach((entry: zip.Entry) => {
          if (entry) {
            var entryPath: string = entry.getName();
            if (/\.class$/.test(entryPath)) {
              var className: string = entryPath.slice(0, -'.class'.length).replace(/\//g, '.');
              if (this.inWhiteList(className)) {
                result.push(className);
              } else {
                this.allExcludedClasses = this.allExcludedClasses.add(className);
              }
            }
          }
        });
      })
      .then(() => result);
  }

  // *createShortNameMap()*: Find all classes with unique class names, and create a map from name to full class name.
  // E.g. if `java.lang.String` is the only class named `String`, the map will contain {'String': 'java.lang.String'}.
  // For non-unique class names, the name is added to the map with a null value.
  private createShortNameMap(): BluePromise<void> {
    dlog('createShortNameMap started');
    // We assume this.allClasses now contains a complete list of all classes
    // that we will process. We scan it now to create the shortToLongNameMap,
    // which allows us to discover class names conflicts.
    // Conflicts are recorded by using null for the longName.
    this.shortToLongNameMap = {};
    this.allClasses.forEach((longName: string): any => {
      var shortName = this.shortClassName(longName);
      if (shortName in reservedShortNames || shortName in this.shortToLongNameMap) {
        // We have a conflict
        this.shortToLongNameMap[shortName] = null;
      } else {
        // No conflict yet
        this.shortToLongNameMap[shortName] = longName;
      }
    });
    dlog('createShortNameMap completed');
    return;
  }

  // *analyzeIncludedClasses()*: Analyze all of the classes included by the configuration, creating a ClassDefinition
  // for each class.
  private analyzeIncludedClasses(): BluePromise<void> {
    dlog('analyzeIncludedClasses started');
    var work: Work = new Work();
    this.allClasses.forEach((className: string): void => work.addTodo(className));

    work.forEach((className: string): void => {
      this.classes[className] = this.mapClass(className, work);
    });

    dlog('analyzeIncludedClasses completed');
    return;
  }

  // *isPublicClass()*: Return true if clazz has public visibility.
  private isPublicClass(clazz: Java.Class): boolean {
    var modifiers: number = clazz.getModifiers();
    var isPublic: boolean = this.Modifier.isPublic(modifiers);
    if (isPublic) {
      var enclosingClass: Java.Class = clazz.getEnclosingClass();
      if (enclosingClass) {
        isPublic = this.isPublicClass(enclosingClass);
        if (!isPublic) {
          dlog('******Pruning class because it is enclosed in nonpublic class:', enclosingClass.getName());
        }
      }
    }
    return isPublic;
  }

  // *loadClassCache()*: Load all classes seen in prescan, pruning any non-public classes.
  private loadClassCache(): BluePromise<void> {
    var nonPublic = Immutable.Set<string>();
    var classLoader = Java.getClassLoader();
    this.allClasses.forEach((className: string): void => {
      var clazz: Java.Class = classLoader.loadClass(className);
      var modifiers: number = clazz.getModifiers();
      var isPublic: boolean = this.isPublicClass(clazz);
      if (isPublic) {
        this.classCache = this.classCache.set(className, clazz);
      } else {
        nonPublic = nonPublic.add(className);
        var isPrivate: boolean = this.Modifier.isPrivate(modifiers);
        var isProtected: boolean = this.Modifier.isProtected(modifiers);
        if (isPrivate) {
          dlog('Pruning private class:', className);
        } else if (isProtected) {
          dlog('Pruning protected class:', className);
        } else {
          dlog('Pruning package-private class:', className);
        }
      }
    });
    this.allClasses = this.allClasses.subtract(nonPublic);
    this.allExcludedClasses = this.allExcludedClasses.union(nonPublic);
    return;
  }

  // *preScanAllClasses()*: scan all jars in the class path and find all classes matching our filter.
  // The result is stored in the member variable this.allClasses and returned as the function result
  private preScanAllClasses(): BluePromise<void> {
    dlog('preScanAllClasses started');
    var options = this.options;
    var result = Immutable.Set<string>();
    var promises: BluePromise<Array<string>>[] = _.map(options.classpath, (jarpath: string) => this.getWhitedListedClassesInJar(jarpath));
    return BluePromise.all(promises)
      .each((classes: Array<string>) => {
        result = result.merge(classes);
      })
      .then(() => {
        this.allClasses = result;
        dlog('preScanAllClasses completed');
      });
  }

  private unconstrainedTypeList(types: Array<string>): string {
    if (!this.options.generics || types.length === 0) {
      return '';
    } else {
      return '<' + _.map(types, () => 'any').join(', ') + '>';
    }
  }

}

export module ClassesMap {

  'use strict';

  // ### MethodDefinition
  // All of the properties on interest for a method.
  export interface MethodDefinition {
    name: string;           // name of method, e.g. 'forEachRemaining'
    declared: string;       // interface where first declared: 'java.util.Iterator'
    returns: string;           // return type, e.g. 'void', 'int', of class name
    genericReturns: string;    // generic return (java) type
    tsReturnsRegular: string;         // return type as a typescript type
    tsGenericReturns: string;  // return type as a typescript generic type
    tsReturns: string;         // return type as a typescript type
    paramNames: Array<string>;  // [ 'arg0' ],
    paramTypes: Array<string>;  // [ 'java.util.function.Consumer', '[S' ],
    tsParamTypes: Array<string>;  // [ 'java.util.function_.Consumer',  'number' ],
    genericParamTypes: Array<string>;
    tsGenericParamTypes: Array<string>;
    tsTypeParameters: Array<string>;
    isStatic: boolean;      // true if this is a static method
    isVarArgs: boolean;     // true if this method's last parameter is varargs ...type
    generic_proto: string;  // The method prototype including generic type information
    ts_generic_proto: ParsedPrototype;  // The method prototype including generic type information, translated to typescript
    plain_proto: string;    // The java method prototype without generic type information
    signature: string;     // A method signature related to the plain_proto prototype above
                            // This signature does not include return type info, as java does not
                            // use return type to distinguish among overloaded methods.
  }


  // ### VariantsArray
  export type VariantsArray = Array<Array<MethodDefinition>>;

  export interface FieldDefinition {
    name: string;
    tsType: string;
    tsRegularType: string;
    tsGenericType: string;
    isStatic: boolean;
    isSynthetic: boolean;
    declaredIn: string;
  }

  export interface ParsedPrototype {
    methodName: string;
    gentypes: string;
    returns: string;
    params: Array<string>;
  }

  // ### ClassDefinition
  // All of the properties on interest for a class.
  export interface ClassDefinition {
    quotedPkgName: string;             // 'java.util.function_'
    packageName: string;               // 'java.util.function'
    genericName: string;               // 'public final class java.lang.Class<T>'
    annotations: string[];
    classTypeName: string;
    fullName: string;                  // 'java.util.Iterator'
    shortName: string;                 // 'Iterator'
    typeParms: Array<string>;
    alias: string;                     // This will be shortName, unless two classes have the same short name,
                                       // of if the short name conflicts with a Javascript type (e.g. Number).
    useAlias: boolean;                 // true if alias is the shortName.
    tsType: string;                    // For primitive wrappers, the ts type, e.g. 'java.lang.String' -> 'string'
    isInterface: boolean;              // true if this is an interface, false for class or primitive type.
    isPrimitive: boolean;              // true for a primitive type, false otherwise.
    superclass: string;                // null if no superclass, otherwise class name
    interfaces: Array<string>;         // [ 'java.util.function.Function' ]
    tsRegularInterfaces: Array<string>;       // [ 'java.util.function_.Function' ]
    tsGenericInterfaces: Array<string>;       // [ 'java.util.function_.Function' ]
    tsInterfaces: Array<string>;       // [ 'java.util.function_.Function' ]
    methods: Array<MethodDefinition>;  // definitions of all methods implemented by this class
    constructors: Array<MethodDefinition>; // definitions of all constructors for this class, may be empty.
    variantsDict: MethodsByNameBySignature;
    variants: VariantsArray;             // definitions of all methods, grouped by method name
    isEnum: boolean;                   // true for an Enum, false otherwise.
    fields: Array<FieldDefinition>;    // array of FieldDefinitions for public fields.

  }

  export interface ClassDefinitionMap {
    [index: string]: ClassDefinition;
  }

}
