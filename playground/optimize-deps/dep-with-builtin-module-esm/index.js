import { readFileSync } from 'node:fs'
import path from 'node:path'

// access from named import
try {
  readFileSync()
} catch (e) {
  console.log('dep-with-builtin-module-esm', e)
}

// access from default import
try {
  path.join()
} catch (e) {
  console.log('dep-with-builtin-module-esm', e)
}

// access from function
export function read() {
  return readFileSync('test')
}
