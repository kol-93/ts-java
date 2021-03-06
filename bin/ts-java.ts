/// <reference path='../typings/bluebird/bluebird.d.ts' />
/// <reference path='../typings/chalk/chalk.d.ts' />
/// <reference path='../typings/commander/commander.d.ts' />
/// <reference path="../typings/debug/debug.d.ts"/>
/// <reference path='../typings/lodash/lodash.d.ts' />
/// <reference path='../typings/node/node.d.ts' />
/// <reference path='../lib/read-package-json.d.ts' />

'use strict';

declare function require(name: string): any;
require('source-map-support').install();

import _ = require('lodash');
import BluePromise = require('bluebird');
import chalk = require('chalk');
import debug = require('debug');
import path = require('path');
import program = require('commander');
import readJson = require('read-package-json');
import Main = require('../lib/ts-java-main');

BluePromise.longStackTraces();
var readJsonPromise = BluePromise.promisify(readJson);

var dlog = debug('ts-java:main');
var bold = chalk.bold;
var error = bold.red;
var warn = bold.yellow;

var helpText = [
'  All configuration options must be specified in a node.js package.json file,',
'  in a property tsjava.',
'',
'  See the README.md file for more information.'
];

var tsJavaAppPackagePath = path.resolve(__dirname, '..', 'package.json');
var packageJsonPath = path.resolve('.', 'package.json');
var tsJavaVersion: string;

readJsonPromise(tsJavaAppPackagePath, console.error, false)
  .then((packageContents: any) => {
    tsJavaVersion = packageContents.version;

    console.log('ts-java version %s', tsJavaVersion);

    program
      .version(tsJavaVersion)
      .option('-q, --quiet', 'Run silently with no output')
      .option('-d, --details', 'Output diagnostic details')
      .option('-j, --json', 'Output json class descriptors for each class to o/json')
      .on('--help', () => {
        _.forEach(helpText, (line: string) => console.log(chalk.bold(line)));
      });

    program.parse(process.argv);
  })
  .then(() => {
    var main = new Main(packageJsonPath);
    return main.run();
  })
  .catch((err: any) => {
    if ('cause' in err && err.cause.code === 'ENOENT' && err.cause.path === packageJsonPath) {
      console.error(error('Not found:', packageJsonPath));
    } else {
      console.error(error(err));
      if (err.stack) {
        console.error(err.stack);
      }
    }
    program.help();
    process.exit(1);
  })
  .done();
