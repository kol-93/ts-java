.PHONY: install install-npm install-tsd lint documentation test testdata unittest compile clean clean-obj clean-tsd clean-npm clean-js-map

default: test

all: install test

lint:
	ls $(TS_SRC) | xargs -n1 node_modules/tslint/bin/tslint --config tslint.json --file
	# node_modules/jshint/bin/jshint --verbose index.js lib

lintOut:
	node_modules/jshint/bin/jshint --verbose out/lib

documentation :
	node_modules/groc/bin/groc --except "**/node_modules/**" --except "out/**" "**/*.ts"  "**/*.js" README.md

test: unittest generate-out

unittest: lint compile
	node_modules/mocha/bin/mocha --timeout 5s --reporter=spec --ui tdd

TS_SRC=$(filter-out %.d.ts,$(wildcard lib/*.ts test/*.ts features/step_definitions/*.ts))
TS_OBJ=$(patsubst %.ts,%.js,$(TS_SRC))
TSC=./node_modules/.bin/tsc
TSC_OPTS=--module commonjs --target ES5 --sourceMap

compile: $(TS_OBJ)

%.js: %.ts
	$(TSC) $(TSC_OPTS) $<
	stat $@ > /dev/null

clean: clean-obj clean-tsd clean-npm clean-js-map

clean-tsd:
	rm -rf typings

clean-npm:
	rm -rf node_modules

clean-obj:
	rm -f $(TS_OBJ)

clean-out:
	rm -rf out/*

clean-js-map:
	rm -rf lib/*.js.map test/*.js.map

generate-out:
	node index.js

install:
	$(MAKE) install-npm
	$(MAKE) install-tsd

install-npm:
	npm install

TSD=./node_modules/.bin/tsd

install-tsd:
	$(TSD) reinstall

TESTDATA=$(wildcard test/data/*.loaded)
testdata : $(TESTDATA)
test/data/%.loaded : ../rsxml/test/data/%.loaded
	cp -p $< $@
