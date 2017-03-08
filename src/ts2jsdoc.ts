#! /usr/bin/env node

import * as ts from "typescript";

import {generateAndWrite} from "./JsDocGenerator";
import {transpile} from "./util";

transpile((basePath: string, config: ts.ParsedCommandLine, tsConfig: any) => generateAndWrite(basePath, config, tsConfig))
  .catch(error => {
    console.error(error.stack || error.message || error)
    process.exit(-1)
  })