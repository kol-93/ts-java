Feature: Package Expressions

As a developer using ts-java
I want to know how to use the tsjava.packages configuration property of package.json
So that I can economically specify the packages my application will use

ts-java is configured using the tsjava property of the package.json,
as documented in the README.md.

The tsjava.packages property is a list of 'package expressions', which can
specify either all classes directly in a given package, or all classes in the
given package or a package nested in the given package.

  Background:
    Given that featureset/package.json uses the following specification for tsjava.packages:
    """
    {
      "packages": [
        "bogus.package.*",
        "bogus.package.root.**",
        "com.redseal.featureset.**",
        "java.util.*"
      ]
    }
    """
    Given this boilerplate to intialize node-java:
    """
    import java = require('../tsJavaModule');
    import Java = java.Java;

    Java.ensureJvm().then(() => {
      {{{ scenario_snippet }}}
    });

    """

  Scenario: A class in a nested package exists
    Given the above boilerplate with following scenario snippet:
    """
    var Thing: Java.com.redseal.featureset.ambiguous.Thing.Static = Java.importClass('com.redseal.featureset.ambiguous.Thing');
    """
    Then it compiles and lints cleanly

  Scenario: A nested class in a non-recursive package exists
    Given the above boilerplate with following scenario snippet:
    """
    var ListItr: Java.java.util.AbstractMap$SimpleEntry.Static = Java.importClass('AbstractMap$SimpleEntry');
    """
    Then it compiles and lints cleanly

  Scenario: Nested packages are not included when a.b.c.* is used to include classes of a.b.c
    Given the above boilerplate with following scenario snippet:
    """
    var Stream: Java.java.util.stream.Stream.Static = Java.importClass('java.util.stream.Stream');
    """
    When compiled it produces this error containing this snippet:
    """
    error TS2305: Module '.+.Java.java.util' has no exported member 'stream'
    """


