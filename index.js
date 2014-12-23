'use strict';

var _ = require('lodash');
var ClassesMap = require('./lib/classes-map.js');
var fs = require('fs');
var glob = require('glob');
var java = require('java');
var JavascriptWriter = require('./lib/javascript-writer.js');
var mkdirp = require('mkdirp');
var Work = require('./lib/work.js');

var BluePromise = require("bluebird");
BluePromise.longStackTraces();

function writeJsons(classes) {
  _.forOwn(classes, function (classMap, className) {
    fs.writeFileSync('out/json/' + classMap.shortName + '.json', JSON.stringify(classMap, null, '  '));
  });
}

function writeLib(classesMap) {
  var jsWriter = new JavascriptWriter(classesMap);
  var classes = classesMap.getClasses();
  return BluePromise.all(_.keys(classes))
    .each(function (className) {
      return jsWriter.writeLibraryClassFile(className);
    });
}

function main() {
  mkdirp.sync('out/json');
  mkdirp.sync('out/lib');
  mkdirp.sync('out/test');

  var filenames = glob.sync('test/**/*.jar');
  for (var j = 0; j < filenames.length; j++) {
    java.classpath.push(filenames[j]);
  }

  var seedClasses = ['com.tinkerpop.gremlin.structure.Graph'];
  var classesMap = new ClassesMap.ClassesMap(java);
  classesMap.initialize(seedClasses);

  writeJsons(classesMap.getClasses());
  writeLib(classesMap).done();
}

main();
