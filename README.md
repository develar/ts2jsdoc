## Installation
   
This module requires Node.js 4.0 or higher to run.

```sh
npm install ts-jsdoc --save-dev
```


## Generate JSDoc from TypeScript

In the `tsconfig.js` set `jsdoc` to path to output directory.

```
"jsdoc": "jsdoc/out"
```

Or to options object:
```json
{
  "out": "our dir",
  "access": "set to public if you want to skip protected members"
}
```

Execute: `ts2jsdoc path-to-dir-with-tsconfig`