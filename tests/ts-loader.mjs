import { existsSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

globalThis.__API_ORIGIN__ = 'https://api.deepseek.com'

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      (specifier.startsWith('./') || specifier.startsWith('../')) &&
      specifier.endsWith('.js') &&
      context.parentURL
    ) {
      const parentPath = fileURLToPath(context.parentURL)
      const jsUrl = new URL(specifier, pathToFileURL(parentPath))
      if (!existsSync(jsUrl)) {
        const tsUrl = new URL(specifier.replace(/\.js$/, '.ts'), pathToFileURL(parentPath))
        if (existsSync(tsUrl)) {
          return nextResolve(tsUrl.href, context)
        }
        const tsxUrl = new URL(specifier.replace(/\.js$/, '.tsx'), pathToFileURL(parentPath))
        if (existsSync(tsxUrl)) {
          return nextResolve(tsxUrl.href, context)
        }
      }
    }
    return nextResolve(specifier, context)
  },
})
